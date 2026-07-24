/**
 * Billing Service
 * Manages user balances, charges, and transaction history
 */

import type { IDatabase } from '../domain/ports/index.js';
import { logger } from '../utils/logger.js';
import { PricingService, PricingTier, PriceCalculation } from './pricing-service.js';
import type { CurrencyService } from './currency-service.js';
import type { AuditService } from './audit-service.js';

export interface UserBilling {
  id: string;
  user_id: string;
  balance_usd: number;
  balance_uah: number;
  daily_limit_usd: number;
  monthly_limit_usd: number;
  total_spent_usd: number;
  total_spent_uah: number;
  total_requests: number;
  is_active: boolean;
  billing_enabled: boolean;
  pricing_tier: PricingTier;
  created_at: Date;
  updated_at: Date;
}

export interface BillingTransaction {
  id: string;
  user_id: string;
  type: 'charge' | 'refund' | 'topup' | 'adjustment';
  amount_usd: number;
  amount_uah: number;
  balance_before_usd: number;
  balance_after_usd: number;
  request_id?: string;
  payment_provider?: string;
  payment_id?: string;
  reference_transaction_id?: string;
  description?: string;
  metadata?: any;
  status?: string;
  created_at: Date;
}

export interface BillingSummary {
  user_id: string;
  email: string;
  name: string;
  balance_usd: number;
  balance_uah: number;
  total_spent_usd: number;
  total_requests: number;
  daily_limit_usd: number;
  monthly_limit_usd: number;
  pricing_tier: PricingTier;
  billing_enabled: boolean;
  is_active: boolean;
  today_spent_usd: number;
  month_spent_usd: number;
  last_request_at?: Date;
  email_notifications: boolean;
  notify_low_balance: boolean;
  notify_payment_success: boolean;
  notify_payment_failure: boolean;
  notify_monthly_report: boolean;
  low_balance_threshold_usd: number;
}

export interface EmailPreferences {
  email_notifications: boolean;
  notify_low_balance: boolean;
  notify_payment_success: boolean;
  notify_payment_failure: boolean;
  notify_monthly_report: boolean;
  low_balance_threshold_usd: number;
}

export class BillingService {
  private pricingService: PricingService;
  private currencyService?: CurrencyService;
  private auditService?: AuditService;
  private referralRewardCallback?: (userId: string, amountUsd: number, amountUah: number, transactionId: string) => Promise<void>;

  constructor(private db: IDatabase, pricingService?: PricingService) {
    this.pricingService = pricingService || new PricingService(db);
  }

  setAuditService(auditService: AuditService): void {
    this.auditService = auditService;
  }

  setCurrencyService(currencyService: CurrencyService): void {
    this.currencyService = currencyService;
  }

  /**
   * Set a callback to process referral rewards on top-up.
   * Decouples BillingService from ReferralService.
   */
  setReferralRewardCallback(cb: (userId: string, amountUsd: number, amountUah: number, transactionId: string) => Promise<void>): void {
    this.referralRewardCallback = cb;
  }

  /**
   * Convert USD to UAH using CurrencyService. Falls back to 0 if service unavailable.
   */
  private async convertToUah(amountUsd: number): Promise<number> {
    if (!this.currencyService || amountUsd <= 0) return 0;
    try {
      const { amountUah } = await this.currencyService.convertUsdToUah(amountUsd);
      return amountUah;
    } catch (err) {
      logger.warn('Failed to convert USD to UAH for billing', { amountUsd, error: (err as Error).message });
      return 0;
    }
  }

  /**
   * Convert UAH to USD using CurrencyService. Falls back to approximate rate if unavailable.
   */
  async convertFromUah(amountUah: number): Promise<number> {
    if (!this.currencyService || amountUah <= 0) return 0;
    try {
      const { amountUsd } = await this.currencyService.convertUahToUsd(amountUah);
      return amountUsd;
    } catch (err) {
      logger.warn('Failed to convert UAH to USD', { amountUah, error: (err as Error).message });
      return Math.round((amountUah / 41.5) * 100) / 100; // fallback approximate rate
    }
  }

  /**
   * PG returns numeric(10,2) as string — coerce to number
   */
  private coerceNumericFields(row: any): UserBilling {
    row.balance_usd = Number(row.balance_usd) || 0;
    row.balance_uah = Number(row.balance_uah) || 0;
    row.daily_limit_usd = Number(row.daily_limit_usd) || 0;
    row.monthly_limit_usd = Number(row.monthly_limit_usd) || 0;
    row.total_spent_usd = Number(row.total_spent_usd) || 0;
    row.total_spent_uah = Number(row.total_spent_uah) || 0;
    row.low_balance_threshold_usd = Number(row.low_balance_threshold_usd) || 0;
    return row as UserBilling;
  }

  /**
   * Get or create user billing account
   */
  async getOrCreateUserBilling(userId: string): Promise<UserBilling> {
    try {
      // Try to get existing billing account
      const result = await this.db.query(
        'SELECT * FROM user_billing WHERE user_id = $1',
        [userId]
      );

      if (result.rows.length > 0) {
        return this.coerceNumericFields(result.rows[0]);
      }

      // Create new billing account with default values
      const defaultTier = this.pricingService.getDefaultTier();
      const createResult = await this.db.query(
        `INSERT INTO user_billing (
          user_id, balance_usd, balance_uah,
          daily_limit_usd, monthly_limit_usd, pricing_tier
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *`,
        [userId, 0.00, 0.00, 10.00, 100.00, defaultTier]
      );

      logger.info('Created billing account', { userId });
      return this.coerceNumericFields(createResult.rows[0]);
    } catch (error: any) {
      logger.error('Failed to get or create user billing', {
        userId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Check if user has sufficient balance for estimated cost
   */
  async checkBalance(userId: string, estimatedCostUsd: number): Promise<{
    hasBalance: boolean;
    currentBalance: number;
    estimatedCost: number;
  }> {
    const billing = await this.getOrCreateUserBilling(userId);

    // Check if billing is enabled
    if (!billing.billing_enabled || !billing.is_active) {
      return {
        hasBalance: true,
        currentBalance: billing.balance_usd,
        estimatedCost: estimatedCostUsd,
      };
    }

    const hasBalance = billing.balance_usd >= estimatedCostUsd;

    if (!hasBalance) {
      logger.warn('Insufficient balance', {
        userId,
        balance: billing.balance_usd,
        required: estimatedCostUsd,
      });
    }

    return {
      hasBalance,
      currentBalance: billing.balance_usd,
      estimatedCost: estimatedCostUsd,
    };
  }

  /**
   * Get the number of completed requests for a user today
   */
  async getDailyRequestCount(userId: string): Promise<number> {
    const result = await this.db.query(
      `SELECT COUNT(*) as cnt
       FROM cost_tracking
       WHERE user_id = $1
         AND created_at >= CURRENT_DATE
         AND status = 'completed'`,
      [userId]
    );
    return parseInt(result.rows[0]?.cnt || '0', 10);
  }

  /**
   * Check if user is within daily and monthly limits
   */
  async checkLimits(userId: string, additionalCostUsd: number): Promise<{
    withinLimits: boolean;
    dailySpent: number;
    dailyLimit: number;
    monthlySpent: number;
    monthlyLimit: number;
    reason?: string;
  }> {
    const billing = await this.getOrCreateUserBilling(userId);

    // Get today's spending
    const todayResult = await this.db.query(
      `SELECT COALESCE(SUM(total_cost_usd), 0) as spent
       FROM cost_tracking
       WHERE user_id = $1
         AND created_at >= CURRENT_DATE
         AND status = 'completed'`,
      [userId]
    );
    const dailySpent = parseFloat(todayResult.rows[0]?.spent || '0');

    // Get this month's spending
    const monthResult = await this.db.query(
      `SELECT COALESCE(SUM(total_cost_usd), 0) as spent
       FROM cost_tracking
       WHERE user_id = $1
         AND created_at >= DATE_TRUNC('month', CURRENT_DATE)
         AND status = 'completed'`,
      [userId]
    );
    const monthlySpent = parseFloat(monthResult.rows[0]?.spent || '0');

    // Check limits
    const dailyExceeded = dailySpent + additionalCostUsd > billing.daily_limit_usd;
    const monthlyExceeded = monthlySpent + additionalCostUsd > billing.monthly_limit_usd;

    let reason: string | undefined;
    if (dailyExceeded) {
      reason = `Daily limit exceeded: $${dailySpent.toFixed(2)}/$${billing.daily_limit_usd.toFixed(2)}`;
    } else if (monthlyExceeded) {
      reason = `Monthly limit exceeded: $${monthlySpent.toFixed(2)}/$${billing.monthly_limit_usd.toFixed(2)}`;
    }

    return {
      withinLimits: !dailyExceeded && !monthlyExceeded,
      dailySpent,
      dailyLimit: billing.daily_limit_usd,
      monthlySpent,
      monthlyLimit: billing.monthly_limit_usd,
      reason,
    };
  }

  /**
   * Charge user for a completed request with pricing tier markup + per-tool markup
   */
  async chargeUser(params: {
    userId: string;
    requestId: string;
    amountUsd: number; // This is the BASE cost (our actual cost)
    amountUah?: number;
    description?: string;
    toolName?: string;
  }): Promise<BillingTransaction & { pricing_details?: PriceCalculation }> {
    const result = await this.db.transaction(async (client) => {
      // Get current billing account (with row lock)
      const billingResult = await client.query(
        'SELECT * FROM user_billing WHERE user_id = $1 FOR UPDATE',
        [params.userId]
      );

      if (billingResult.rows.length === 0) {
        throw new Error('User billing account not found');
      }

      const billing = billingResult.rows[0];
      const pricingTier: PricingTier = billing.pricing_tier || 'startup';

      // Fetch per-tool markup from tool_pricing table
      let toolMarkupPercent = 0;
      if (params.toolName) {
        try {
          const toolPricingResult = await client.query(
            'SELECT markup_percent FROM tool_pricing WHERE tool_name = $1 AND is_active = true',
            [params.toolName]
          );
          if (toolPricingResult.rows.length > 0) {
            toolMarkupPercent = Number(toolPricingResult.rows[0].markup_percent) || 0;
          }
        } catch (err: any) {
          logger.warn('Failed to fetch tool markup, using 0', { toolName: params.toolName, error: err.message });
        }
      }

      // Calculate price with markup based on tier
      const priceCalc = this.pricingService.calculatePrice(params.amountUsd, pricingTier);

      // Apply additional per-tool markup on top of tier markup
      const toolMarkupAmount = params.amountUsd * (toolMarkupPercent / 100);
      const totalChargeAmount = priceCalc.price_usd + toolMarkupAmount;

      // The amount we charge the client
      const chargeAmount = totalChargeAmount;

      const balanceBefore = parseFloat(billing.balance_usd);
      const balanceAfter = balanceBefore - chargeAmount;
      const balanceBeforeUah = parseFloat(billing.balance_uah) || 0;

      // Recalculate entire UAH balance from new USD balance using current NBU rate
      const balanceAfterUah = await this.convertToUah(balanceAfter);
      const chargeAmountUah = balanceBeforeUah - balanceAfterUah;

      // Update balance and statistics — set balance_uah to recalculated value
      await client.query(
        `UPDATE user_billing
         SET balance_usd = balance_usd - $1,
             balance_uah = $2,
             total_spent_usd = total_spent_usd + $1,
             total_spent_uah = total_spent_uah + $3,
             total_requests = total_requests + 1,
             updated_at = NOW()
         WHERE user_id = $4`,
        [chargeAmount, balanceAfterUah, chargeAmountUah > 0 ? chargeAmountUah : 0, params.userId]
      );

      // Record transaction with pricing metadata
      const transactionMetadata = {
        base_cost_usd: priceCalc.cost_usd,
        markup_percentage: priceCalc.markup_percentage,
        markup_amount_usd: priceCalc.markup_amount_usd,
        tool_markup_percent: toolMarkupPercent,
        tool_markup_amount_usd: Number(toolMarkupAmount.toFixed(6)),
        pricing_tier: pricingTier,
        tool_name: params.toolName,
      };

      const transactionResult = await client.query(
        `INSERT INTO billing_transactions (
          user_id, type, amount_usd, amount_uah,
          balance_before_usd, balance_after_usd,
          balance_before_uah, balance_after_uah,
          request_id, description, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *`,
        [
          params.userId,
          'charge',
          chargeAmount,
          chargeAmountUah,
          balanceBefore,
          balanceAfter,
          balanceBeforeUah,
          balanceAfterUah,
          params.requestId,
          params.description || `Request ${params.requestId}`,
          JSON.stringify(transactionMetadata),
        ]
      );

      // Update cost_tracking table with pricing details (including tool markup)
      const totalMarkupAmount = Number((priceCalc.markup_amount_usd + toolMarkupAmount).toFixed(6));
      const totalMarkupPercentage = params.amountUsd > 0
        ? Number(((totalMarkupAmount / params.amountUsd) * 100).toFixed(4))
        : priceCalc.markup_percentage;
      await client.query(
        `UPDATE cost_tracking
         SET base_cost_usd = $1,
             markup_percentage = $2,
             markup_amount_usd = $3,
             client_tier = $4,
             total_cost_usd = $5
         WHERE request_id = $6`,
        [
          priceCalc.cost_usd,
          totalMarkupPercentage,
          totalMarkupAmount,
          pricingTier,
          chargeAmount,
          params.requestId,
        ]
      );

      const transaction = transactionResult.rows[0] as BillingTransaction;

      logger.info('User charged with markup', {
        userId: params.userId,
        requestId: params.requestId,
        toolName: params.toolName,
        baseCost: `$${priceCalc.cost_usd.toFixed(6)}`,
        tierMarkup: `${priceCalc.markup_percentage}%`,
        toolMarkup: `${toolMarkupPercent}%`,
        charged: `$${chargeAmount.toFixed(6)}`,
        profit: `$${(priceCalc.markup_amount_usd + toolMarkupAmount).toFixed(6)}`,
        tier: pricingTier,
        balanceAfter: `$${balanceAfter.toFixed(2)}`,
      });

      return {
        ...transaction,
        pricing_details: priceCalc,
      };
    });

    // Audit: balance.charge
    if (this.auditService) {
      this.auditService.log({
        userId: params.userId,
        action: 'balance.charge',
        resourceType: 'billing_transaction',
        resourceId: result.id,
        details: { amountUsd: result.amount_usd, requestId: params.requestId, toolName: params.toolName },
      }).catch(err => logger.warn('[Audit] Failed to log balance.charge', { error: (err as Error).message }));
    }

    return result;
  }

  /**
   * Top up user balance (manual or via payment provider)
   */
  async topUpBalance(params: {
    userId: string;
    amountUsd: number;
    amountUah?: number;
    description?: string;
    paymentProvider?: string;
    paymentId?: string;
    metadata?: any;
  }): Promise<BillingTransaction> {
    const result = await this.db.transaction(async (client) => {
      // Get current billing account (with row lock)
      const billingResult = await client.query(
        'SELECT * FROM user_billing WHERE user_id = $1 FOR UPDATE',
        [params.userId]
      );

      if (billingResult.rows.length === 0) {
        throw new Error('User billing account not found');
      }

      const billing = billingResult.rows[0];
      const balanceBefore = parseFloat(billing.balance_usd);
      const balanceAfter = balanceBefore + params.amountUsd;
      const balanceBeforeUah = parseFloat(billing.balance_uah) || 0;

      // Recalculate entire UAH balance from new USD balance using current NBU rate
      const balanceAfterUah = await this.convertToUah(balanceAfter);
      const topUpAmountUah = balanceAfterUah - balanceBeforeUah;

      // Update balance — set balance_uah to recalculated value
      await client.query(
        `UPDATE user_billing
         SET balance_usd = balance_usd + $1,
             balance_uah = $2,
             updated_at = NOW()
         WHERE user_id = $3`,
        [params.amountUsd, balanceAfterUah, params.userId]
      );

      // Record transaction
      const transactionResult = await client.query(
        `INSERT INTO billing_transactions (
          user_id, type, amount_usd, amount_uah,
          balance_before_usd, balance_after_usd,
          balance_before_uah, balance_after_uah,
          description, payment_provider, payment_id, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING *`,
        [
          params.userId,
          'topup',
          params.amountUsd,
          topUpAmountUah,
          balanceBefore,
          balanceAfter,
          balanceBeforeUah,
          balanceAfterUah,
          params.description || `Top up $${params.amountUsd}`,
          params.paymentProvider,
          params.paymentId,
          JSON.stringify(params.metadata || {}),
        ]
      );

      const transaction = transactionResult.rows[0] as BillingTransaction;

      logger.info('Balance topped up', {
        userId: params.userId,
        amount: params.amountUsd,
        balanceAfter,
        provider: params.paymentProvider,
      });

      return transaction;
    });

    // Audit: balance.topup
    if (this.auditService) {
      this.auditService.log({
        userId: params.userId,
        action: 'balance.topup',
        resourceType: 'billing_transaction',
        resourceId: result.id,
        details: { amountUsd: params.amountUsd, amountUah: params.amountUah, provider: params.paymentProvider },
      }).catch(err => logger.warn('[Audit] Failed to log balance.topup', { error: (err as Error).message }));
    }

    // Process referral reward outside the transaction (fire and forget)
    if (this.referralRewardCallback && result.type === 'topup' && params.paymentProvider !== 'referral') {
      this.referralRewardCallback(params.userId, params.amountUsd, params.amountUah || 0, result.id).catch(err => {
        logger.warn('Referral reward processing failed', { userId: params.userId, error: (err as Error).message });
      });
    }

    return result;
  }

  /**
   * Get billing summary for user
   */
  async getBillingSummary(userId: string): Promise<BillingSummary | null> {
    try {
      const result = await this.db.query(
        'SELECT * FROM user_billing_summary WHERE user_id = $1',
        [userId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return result.rows[0] as BillingSummary;
    } catch (error: any) {
      logger.error('Failed to get billing summary', {
        userId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get transaction history for user
   */
  async getTransactionHistory(
    userId: string,
    options: {
      limit?: number;
      offset?: number;
      type?: string;
    } = {}
  ): Promise<BillingTransaction[]> {
    const { limit = 50, offset = 0, type } = options;

    try {
      let query = `
        SELECT * FROM billing_transactions
        WHERE user_id = $1
      `;
      const params: any[] = [userId];

      if (type) {
        query += ' AND type = $2';
        params.push(type);
      }

      query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
      params.push(limit, offset);

      const result = await this.db.query(query, params);
      return result.rows as BillingTransaction[];
    } catch (error: any) {
      logger.error('Failed to get transaction history', {
        userId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Update user billing settings (limits, status, pricing tier)
   */
  async updateBillingSettings(
    userId: string,
    settings: {
      dailyLimitUsd?: number;
      monthlyLimitUsd?: number;
      isActive?: boolean;
      billingEnabled?: boolean;
      pricingTier?: PricingTier;
      email_notifications?: boolean;
      notify_low_balance?: boolean;
      notify_payment_success?: boolean;
      notify_payment_failure?: boolean;
      notify_monthly_report?: boolean;
      low_balance_threshold_usd?: number;
    }
  ): Promise<{ refund_uah?: number; refund_usd?: number }> {
    try {
      const updates: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;
      let refundResult: { refund_uah?: number; refund_usd?: number } = {};

      if (settings.dailyLimitUsd !== undefined) {
        updates.push(`daily_limit_usd = $${paramIndex++}`);
        params.push(settings.dailyLimitUsd);
      }

      if (settings.monthlyLimitUsd !== undefined) {
        updates.push(`monthly_limit_usd = $${paramIndex++}`);
        params.push(settings.monthlyLimitUsd);
      }

      if (settings.isActive !== undefined) {
        updates.push(`is_active = $${paramIndex++}`);
        params.push(settings.isActive);
      }

      if (settings.billingEnabled !== undefined) {
        updates.push(`billing_enabled = $${paramIndex++}`);
        params.push(settings.billingEnabled);
      }

      if (settings.pricingTier !== undefined) {
        // Validate pricing tier
        if (!this.pricingService.isValidTier(settings.pricingTier)) {
          throw new Error(`Invalid pricing tier: ${settings.pricingTier}`);
        }

        // Check for downgrade → issue prorated refund
        const currentBilling = await this.getOrCreateUserBilling(userId);
        const oldTier = currentBilling.pricing_tier || 'free';
        const newTier = settings.pricingTier;

        if (oldTier !== newTier) {
          const allTiers = this.pricingService.getAllTiers();
          const oldTierConfig = allTiers.find(t => t.tier === oldTier);
          const newTierConfig = allTiers.find(t => t.tier === newTier);
          const oldPrice = oldTierConfig?.monthly_price_usd || 0;
          const newPrice = newTierConfig?.monthly_price_usd || 0;

          if (oldPrice > newPrice) {
            // Downgrade: refund the monthly price difference to balance
            const refundUsd = oldPrice - newPrice;
            const refundUah = await this.convertToUah(refundUsd);

            if (refundUsd > 0) {
              const balanceBefore = parseFloat(String(currentBilling.balance_usd)) || 0;
              const balanceAfter = balanceBefore + refundUsd;

              await this.db.query(
                `UPDATE user_billing
                 SET balance_usd = balance_usd + $1,
                     balance_uah = balance_uah + $2,
                     updated_at = NOW()
                 WHERE user_id = $3`,
                [refundUsd, refundUah, userId]
              );

              // Record refund transaction
              await this.db.query(
                `INSERT INTO billing_transactions
                  (user_id, type, amount_usd, amount_uah, balance_before_usd, balance_after_usd, description)
                 VALUES ($1, 'refund', $2, $3, $4, $5, $6)`,
                [userId, refundUsd, refundUah, balanceBefore, balanceAfter,
                 `Повернення за зміну тарифу: ${oldTier} → ${newTier}`]
              );

              refundResult = { refund_usd: refundUsd, refund_uah: refundUah };
              logger.info('Plan downgrade refund issued', {
                userId, oldTier, newTier, refundUsd, refundUah,
              });
            }
          }
        }

        updates.push(`pricing_tier = $${paramIndex++}`);
        params.push(settings.pricingTier);
      }

      if (settings.email_notifications !== undefined) {
        updates.push(`email_notifications = $${paramIndex++}`);
        params.push(settings.email_notifications);
      }

      if (settings.notify_low_balance !== undefined) {
        updates.push(`notify_low_balance = $${paramIndex++}`);
        params.push(settings.notify_low_balance);
      }

      if (settings.notify_payment_success !== undefined) {
        updates.push(`notify_payment_success = $${paramIndex++}`);
        params.push(settings.notify_payment_success);
      }

      if (settings.notify_payment_failure !== undefined) {
        updates.push(`notify_payment_failure = $${paramIndex++}`);
        params.push(settings.notify_payment_failure);
      }

      if (settings.notify_monthly_report !== undefined) {
        updates.push(`notify_monthly_report = $${paramIndex++}`);
        params.push(settings.notify_monthly_report);
      }

      if (settings.low_balance_threshold_usd !== undefined) {
        updates.push(`low_balance_threshold_usd = $${paramIndex++}`);
        params.push(settings.low_balance_threshold_usd);
      }

      if (updates.length === 0) {
        return refundResult;
      }

      params.push(userId);
      const query = `
        UPDATE user_billing
        SET ${updates.join(', ')}, updated_at = NOW()
        WHERE user_id = $${paramIndex}
      `;

      await this.db.query(query, params);

      logger.info('Billing settings updated', { userId, settings });
      return refundResult;
    } catch (error: any) {
      logger.error('Failed to update billing settings', {
        userId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get user's pricing tier
   */
  async getUserPricingTier(userId: string): Promise<PricingTier> {
    const billing = await this.getOrCreateUserBilling(userId);
    return billing.pricing_tier || 'startup';
  }

  /**
   * Get pricing information for user
   */
  async getUserPricingInfo(userId: string): Promise<{
    current_tier: PricingTier;
    tier_config: any;
    recommended_tier?: PricingTier;
    monthly_spending_usd: number;
  }> {
    const billing = await this.getOrCreateUserBilling(userId);
    const tier = billing.pricing_tier || 'startup';
    const tierConfig = this.pricingService.getTierConfig(tier);

    // Get monthly spending
    const monthResult = await this.db.query(
      `SELECT COALESCE(SUM(total_cost_usd), 0) as spent
       FROM cost_tracking
       WHERE user_id = $1
         AND created_at >= DATE_TRUNC('month', CURRENT_DATE)
         AND status = 'completed'`,
      [userId]
    );
    const monthlySpending = parseFloat(monthResult.rows[0]?.spent || '0');

    const recommendedTier = this.pricingService.getRecommendedTier(monthlySpending);

    return {
      current_tier: tier,
      tier_config: tierConfig,
      recommended_tier: tier !== recommendedTier ? recommendedTier : undefined,
      monthly_spending_usd: monthlySpending,
    };
  }

  /**
   * Get all available pricing tiers
   */
  getAllPricingTiers(): any[] {
    return this.pricingService.getAllTiers();
  }

  /**
   * Calculate estimated price for a cost
   */
  calculateEstimatedPrice(costUsd: number, tier?: PricingTier): PriceCalculation {
    const pricingTier = tier || this.pricingService.getDefaultTier();
    return this.pricingService.calculatePrice(costUsd, pricingTier);
  }

  /**
   * Set invoice number on a billing transaction
   */
  async setTransactionInvoiceNumber(transactionId: string, invoiceNumber: string): Promise<void> {
    try {
      await this.db.query(
        `UPDATE billing_transactions SET invoice_number = $1 WHERE id = $2`,
        [invoiceNumber, transactionId]
      );
    } catch (error: any) {
      logger.error('Failed to set invoice number', {
        transactionId,
        invoiceNumber,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get billing invoices (top-up transactions with invoice metadata)
   */
  async getBillingInvoices(
    userId: string,
    options: { limit?: number; offset?: number; status?: string } = {}
  ): Promise<{ invoices: any[]; total: number }> {
    const { limit = 50, offset = 0 } = options;

    try {
      // Count total
      const countResult = await this.db.query(
        `SELECT COUNT(*) as total FROM billing_transactions
         WHERE user_id = $1 AND type = 'topup'`,
        [userId]
      );
      const total = parseInt(countResult.rows[0]?.total || '0', 10);

      // Fetch invoices from top-up transactions
      const result = await this.db.query(
        `SELECT
          bt.id,
          bt.invoice_number,
          bt.created_at as date,
          bt.amount_usd,
          bt.amount_uah,
          bt.payment_provider,
          bt.payment_id,
          bt.description,
          bt.metadata,
          u.email as customer_email,
          u.name as customer_name
        FROM billing_transactions bt
        JOIN users u ON u.id = bt.user_id
        WHERE bt.user_id = $1 AND bt.type = 'topup'
        ORDER BY bt.created_at DESC
        LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      );

      const invoices = result.rows.map((row: any, idx: number) => ({
        invoiceNumber: row.invoice_number || `INV-${row.id.slice(0, 8).toUpperCase()}`,
        date: row.date,
        customerName: row.customer_name,
        customerEmail: row.customer_email,
        amount: Number(row.amount_uah) || Number(row.amount_usd) * 41.5,
        amountUsd: Number(row.amount_usd),
        currency: Number(row.amount_uah) > 0 ? 'UAH' : 'USD',
        paymentMethod: row.payment_provider || 'unknown',
        paymentId: row.payment_id,
        status: 'paid',
        description: row.description,
      }));

      return { invoices, total };
    } catch (error: any) {
      logger.error('Failed to get billing invoices', { userId, error: error.message });
      throw error;
    }
  }

  /**
   * Get billing statistics for a given period
   */
  async getBillingStatistics(userId: string, period: string): Promise<any> {
    try {
      const periodDays: Record<string, number> = {
        '7d': 7, '30d': 30, '90d': 90, 'year': 365,
      };
      const days = periodDays[period] || 30;
      const prevDays = days * 2; // for comparison

      // Current period stats
      const statsResult = await this.db.query(
        `SELECT
          COUNT(*) as total_requests,
          COALESCE(SUM(total_cost_usd), 0) as total_cost,
          COALESCE(SUM(openai_total_tokens), 0) as openai_tokens,
          CASE WHEN COUNT(*) > 0
            THEN COALESCE(SUM(total_cost_usd), 0) / COUNT(*)
            ELSE 0
          END as avg_cost_per_request
        FROM cost_tracking
        WHERE user_id = $1
          AND status = 'completed'
          AND created_at >= NOW() - ($2 || ' days')::interval`,
        [userId, days.toString()]
      );

      // Previous period stats (for comparison)
      const prevResult = await this.db.query(
        `SELECT
          COUNT(*) as total_requests,
          COALESCE(SUM(total_cost_usd), 0) as total_cost
        FROM cost_tracking
        WHERE user_id = $1
          AND status = 'completed'
          AND created_at >= NOW() - ($2 || ' days')::interval
          AND created_at < NOW() - ($3 || ' days')::interval`,
        [userId, prevDays.toString(), days.toString()]
      );

      // Daily data
      const dailyResult = await this.db.query(
        `SELECT
          DATE(created_at) as date,
          COUNT(*) as requests,
          COALESCE(SUM(total_cost_usd), 0) as cost
        FROM cost_tracking
        WHERE user_id = $1
          AND status = 'completed'
          AND created_at >= NOW() - ($2 || ' days')::interval
        GROUP BY DATE(created_at)
        ORDER BY date`,
        [userId, days.toString()]
      );

      // Cost by service (tool_name grouped)
      const serviceResult = await this.db.query(
        `SELECT
          tool_name as name,
          COALESCE(SUM(total_cost_usd), 0) as cost,
          COUNT(*) as count
        FROM cost_tracking
        WHERE user_id = $1
          AND status = 'completed'
          AND created_at >= NOW() - ($2 || ' days')::interval
        GROUP BY tool_name
        ORDER BY cost DESC
        LIMIT 10`,
        [userId, days.toString()]
      );

      const stats = statsResult.rows[0];
      const prev = prevResult.rows[0];
      const totalCost = Number(stats.total_cost);
      const totalRequests = Number(stats.total_requests);
      const prevTotalCost = Number(prev?.total_cost || 0);
      const prevTotalRequests = Number(prev?.total_requests || 0);

      // Build costByService with percentage
      const serviceColors = ['#8B5E3C', '#A0522D', '#CD853F', '#D2B48C', '#DEB887', '#F5DEB3', '#FFDEAD', '#FFE4B5'];
      const costByService = serviceResult.rows.map((row: any, idx: number) => ({
        name: row.name,
        cost: Number(row.cost),
        count: Number(row.count),
        color: serviceColors[idx % serviceColors.length],
        percentage: totalCost > 0 ? Number(((Number(row.cost) / totalCost) * 100).toFixed(1)) : 0,
      }));

      // Top tools
      const topTools = serviceResult.rows.map((row: any) => ({
        name: row.name,
        count: Number(row.count),
        cost: Number(row.cost),
        percentage: totalCost > 0 ? Number(((Number(row.cost) / totalCost) * 100).toFixed(1)) : 0,
      }));

      return {
        period,
        totalRequests,
        totalCost,
        openaiTokens: Number(stats.openai_tokens),
        avgCostPerRequest: Number(Number(stats.avg_cost_per_request).toFixed(6)),
        costByService,
        topTools,
        dailyData: dailyResult.rows.map((row: any) => ({
          date: row.date,
          requests: Number(row.requests),
          cost: Number(row.cost),
        })),
        previousPeriod: prevTotalRequests > 0 ? {
          totalRequests: prevTotalRequests,
          totalCost: prevTotalCost,
          requestsChange: prevTotalRequests > 0
            ? Number((((totalRequests - prevTotalRequests) / prevTotalRequests) * 100).toFixed(1))
            : 0,
          costChange: prevTotalCost > 0
            ? Number((((totalCost - prevTotalCost) / prevTotalCost) * 100).toFixed(1))
            : 0,
        } : undefined,
      };
    } catch (error: any) {
      logger.error('Failed to get billing statistics', { userId, error: error.message });
      throw error;
    }
  }

  /**
   * Get saved payment methods for user
   */
  async getPaymentMethods(userId: string): Promise<any[]> {
    try {
      const result = await this.db.query(
        `SELECT * FROM billing_payment_methods
         WHERE user_id = $1
         ORDER BY is_primary DESC, created_at DESC`,
        [userId]
      );
      return result.rows.map((row: any) => ({
        id: row.id,
        provider: row.provider,
        cardLast4: row.card_last4,
        cardBrand: row.card_brand,
        cardBank: row.card_bank,
        walletAddress: row.wallet_address,
        cryptoNetwork: row.crypto_network,
        label: row.label,
        isPrimary: row.is_primary,
        createdAt: row.created_at,
      }));
    } catch (error: any) {
      // Table may not exist yet — return empty array
      if (error.code === '42P01') return [];
      logger.error('Failed to get payment methods', { userId, error: error.message });
      throw error;
    }
  }

  /**
   * Save a payment method (upsert by user + provider + last4 to avoid duplicates)
   */
  async savePaymentMethod(userId: string, data: {
    provider: string;
    cardLast4?: string;
    cardBrand?: string;
    cardBank?: string;
    label?: string;
  }): Promise<void> {
    try {
      // Upsert: if same card (provider + last4) already exists, update it
      await this.db.query(
        `INSERT INTO billing_payment_methods (id, user_id, provider, card_last4, card_brand, card_bank, label, is_primary)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6,
           NOT EXISTS(SELECT 1 FROM billing_payment_methods WHERE user_id = $1)
         )
         ON CONFLICT ON CONSTRAINT billing_payment_methods_user_provider_card_unique
         DO UPDATE SET card_brand = EXCLUDED.card_brand, card_bank = EXCLUDED.card_bank, label = EXCLUDED.label, updated_at = NOW()`,
        [userId, data.provider, data.cardLast4 || null, data.cardBrand || null, data.cardBank || null, data.label || null]
      );
    } catch (error: any) {
      // Non-critical — don't fail the payment
      logger.warn('Failed to save payment method', { userId, error: error.message });
    }
  }

  /**
   * Remove a saved payment method
   */
  async removePaymentMethod(userId: string, methodId: string): Promise<void> {
    await this.db.transaction(async (client) => {
      const result = await client.query(
        'DELETE FROM billing_payment_methods WHERE id = $1 AND user_id = $2 RETURNING is_primary',
        [methodId, userId]
      );
      if (result.rowCount === 0) {
        throw new Error('Payment method not found');
      }
      // If deleted card was primary, promote the most recent remaining card
      if (result.rows[0].is_primary) {
        await client.query(
          `UPDATE billing_payment_methods SET is_primary = true
           WHERE id = (
             SELECT id FROM billing_payment_methods
             WHERE user_id = $1
             ORDER BY created_at DESC LIMIT 1
           )`,
          [userId]
        );
      }
    });
  }

  /**
   * Set a payment method as primary
   */
  async setPrimaryPaymentMethod(userId: string, methodId: string): Promise<void> {
    await this.db.transaction(async (client) => {
      // Unset current primary
      await client.query(
        'UPDATE billing_payment_methods SET is_primary = false WHERE user_id = $1 AND is_primary = true',
        [userId]
      );
      // Set new primary
      const result = await client.query(
        'UPDATE billing_payment_methods SET is_primary = true WHERE id = $1 AND user_id = $2',
        [methodId, userId]
      );
      if (result.rowCount === 0) {
        throw new Error('Payment method not found');
      }
    });
  }

  /**
   * Get billing info (company details for invoicing)
   */
  async getBillingInfo(userId: string): Promise<{
    companyName: string;
    edrpou: string;
    address: string;
    city: string;
    postalCode: string;
    country: string;
    email: string;
    phone: string;
  }> {
    const result = await this.db.query(
      `SELECT company_name, edrpou, billing_address, billing_city,
              billing_postal_code, billing_country, billing_email, billing_phone
       FROM user_billing WHERE user_id = $1`,
      [userId]
    );
    const row = result.rows[0];
    return {
      companyName: row?.company_name || '',
      edrpou: row?.edrpou || '',
      address: row?.billing_address || '',
      city: row?.billing_city || '',
      postalCode: row?.billing_postal_code || '',
      country: row?.billing_country || 'Ukraine',
      email: row?.billing_email || '',
      phone: row?.billing_phone || '',
    };
  }

  /**
   * Update billing info (company details for invoicing)
   */
  async updateBillingInfo(userId: string, data: {
    companyName?: string;
    edrpou?: string;
    address?: string;
    city?: string;
    postalCode?: string;
    country?: string;
    email?: string;
    phone?: string;
  }): Promise<void> {
    await this.db.query(
      `UPDATE user_billing SET
        company_name = COALESCE($2, company_name),
        edrpou = COALESCE($3, edrpou),
        billing_address = COALESCE($4, billing_address),
        billing_city = COALESCE($5, billing_city),
        billing_postal_code = COALESCE($6, billing_postal_code),
        billing_country = COALESCE($7, billing_country),
        billing_email = COALESCE($8, billing_email),
        billing_phone = COALESCE($9, billing_phone),
        updated_at = NOW()
       WHERE user_id = $1`,
      [userId, data.companyName, data.edrpou, data.address, data.city,
       data.postalCode, data.country, data.email, data.phone]
    );
  }

  /**
   * Get email notification preferences for a user
   */
  async getEmailPreferences(userId: string): Promise<EmailPreferences> {
    try {
      const result = await this.db.query(
        `SELECT
          email_notifications,
          notify_low_balance,
          notify_payment_success,
          notify_payment_failure,
          notify_monthly_report,
          low_balance_threshold_usd
        FROM user_billing
        WHERE user_id = $1`,
        [userId]
      );

      if (result.rows.length === 0) {
        return {
          email_notifications: true,
          notify_low_balance: true,
          notify_payment_success: true,
          notify_payment_failure: true,
          notify_monthly_report: true,
          low_balance_threshold_usd: 5.00,
        };
      }

      const row = result.rows[0];
      return {
        email_notifications: row.email_notifications ?? true,
        notify_low_balance: row.notify_low_balance ?? true,
        notify_payment_success: row.notify_payment_success ?? true,
        notify_payment_failure: row.notify_payment_failure ?? true,
        notify_monthly_report: row.notify_monthly_report ?? true,
        low_balance_threshold_usd: parseFloat(row.low_balance_threshold_usd) || 5.00,
      };
    } catch (error: any) {
      logger.error('Failed to get email preferences', {
        userId,
        error: error.message,
      });
      throw error;
    }
  }
}
