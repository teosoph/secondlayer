import { DocumentSection, SectionType } from '../types/index.js';
import { logger } from '../utils/logger.js';
import type { ILLMPort } from '../domain/ports/index.js';

interface StructuralMarker {
  type: SectionType;
  patterns: RegExp[];
  priority: number;
  isHeading: boolean;
}

interface BoundaryMatch {
  type: SectionType;
  index: number;
  matchLength: number;
  priority: number;
}

const AMOUNT_PATTERNS: RegExp[] = [
  /сума\s+\d+/gi,
  /штраф\s+\d+/gi,
  /компенсація\s+\d+/gi,
  /\d[\d\s]*[\.,]?\d*\s*грн/gi,
  /\d[\d\s]*[\.,]?\d*\s*гривень/gi,
  /\d[\d\s]*[\.,]?\d*\s*грив\./gi,
  /\d[\d\s]*[\.,]?\d*\s*копійок/gi,
];

export class SemanticSectionizer {
  private structuralMarkers: StructuralMarker[];

  constructor(private readonly llm?: ILLMPort) {
    this.structuralMarkers = [
      {
        type: SectionType.FACTS,
        patterns: [
          /\n\s*(ВСТАНОВИВ|УСТАНОВИВ|встановив|установив)\s*[:.\s]/,
          /\n\s*[Сс]уд\s+встановив/,
          /\n\s*Обставини справи/i,
          /\n\s*Фактичні обставини/i,
        ],
        priority: 1,
        isHeading: true,
      },
      {
        type: SectionType.CLAIMS,
        patterns: [
          /\n\s*Короткий зміст позовних вимог/i,
          /\n\s*Зміст позовних вимог/i,
          /\n\s*[Пп]озовна заява мотивована/i,
          /\n\s*[Пп]озивач\s+(просить|зазначає|вказує|стверджує)/i,
        ],
        priority: 2,
        isHeading: true,
      },
      {
        type: SectionType.PROCEDURAL_HISTORY,
        patterns: [
          /\n\s*Короткий зміст (рішень?|ухвал|постанов)/i,
          /\n\s*Короткий зміст рішень судів/i,
          /\n\s*Фактичні обставини справи, встановлені судами/i,
          /\n\s*[Рр]ішенням\s+.{1,60}суду\s+.{1,40}від\s+\d/,
        ],
        priority: 3,
        isHeading: true,
      },
      {
        type: SectionType.LAW_REFERENCES,
        patterns: [
          /\n\s*Правове обґрунтування/i,
          /\n\s*Норми права/i,
          /\n\s*Нормативне регулювання/i,
        ],
        priority: 4,
        isHeading: true,
      },
      {
        type: SectionType.MOTIVES,
        patterns: [
          /\n\s*Мотивувальна частина/i,
          /\n\s*Мотиви суду/i,
          /\n\s*МОТИВИ/i,
          /\n\s*Суд зазначає/i,
        ],
        priority: 5,
        isHeading: true,
      },
      {
        type: SectionType.COURT_REASONING,
        patterns: [
          /\n\s*[Сс]уд (вважає|дійшов висновку|приходить до висновку)/,
          /\n\s*[Оо]бґрунтування суду/i,
          /\n\s*Висновки суду/i,
        ],
        priority: 6,
        isHeading: true,
      },
      {
        type: SectionType.DECISION,
        patterns: [
          /\n\s*Резолютивна частина/i,
          /\n\s*(УХВАЛИВ|ПОСТАНОВИВ|ВИРІШИВ)\s*[:.\s]/,
          /\n\s*(ухвалив|постановив|вирішив)\s*[:.\s]/,
          /\n\s*Керуючись\s+/i,
        ],
        priority: 7,
        isHeading: true,
      },
    ];
  }

  /** Collapse spaced court markers: "в с т а н о в и в" → "встановив" */
  private normalizeSpacedMarkers(text: string): string {
    const spacedPatterns: Array<[RegExp, string]> = [
      [/[Вв]\s+[Сс]\s+[Тт]\s+[Аа]\s+[Нн]\s+[Оо]\s+[Вв]\s+[Ии]\s+[Вв]/g, 'ВСТАНОВИВ'],
      [/[Уу]\s+[Сс]\s+[Тт]\s+[Аа]\s+[Нн]\s+[Оо]\s+[Вв]\s+[Ии]\s+[Вв]/g, 'УСТАНОВИВ'],
      [/[Пп]\s+[Оо]\s+[Сс]\s+[Тт]\s+[Аа]\s+[Нн]\s+[Оо]\s+[Вв]\s+[Ии]\s+[Вв]/g, 'ПОСТАНОВИВ'],
      [/[Уу]\s+[Хх]\s+[Вв]\s+[Аа]\s+[Лл]\s+[Ии]\s+[Вв]/g, 'УХВАЛИВ'],
      [/[Вв]\s+[Ии]\s+[Рр]\s+[Іі]\s+[Шш]\s+[Ии]\s+[Вв]/g, 'ВИРІШИВ'],
    ];
    let result = text;
    for (const [pattern, replacement] of spacedPatterns) {
      result = result.replace(pattern, replacement);
    }
    return result;
  }

  async extractSections(
    text: string,
    useLLM: boolean = false
  ): Promise<DocumentSection[]> {
    const normalizedText = this.normalizeSpacedMarkers(text);
    const boundaries = this.findAllBoundaries(normalizedText);

    if (boundaries.length === 0 && useLLM) {
      return await this.llmAssistedExtraction(text);
    }

    const sections = this.buildSectionsFromBoundaries(normalizedText, boundaries);

    const amountSections = this.extractAmountSections(normalizedText, sections);
    sections.push(...amountSections);

    for (const section of sections) {
      section.confidence = this.calculateConfidence(section, text);
    }

    const validSections = sections.filter((s) => s.confidence >= 0.5);

    if (useLLM && validSections.length === 0) {
      return await this.llmAssistedExtraction(text);
    }

    return validSections.sort((a, b) => a.start_index - b.start_index);
  }

  private findAllBoundaries(text: string): BoundaryMatch[] {
    const boundaries: BoundaryMatch[] = [];

    for (const marker of this.structuralMarkers) {
      for (const pattern of marker.patterns) {
        const freshPattern = new RegExp(pattern.source, pattern.flags);
        const match = freshPattern.exec(text);
        if (match) {
          const existingAtSamePos = boundaries.find(
            (b) => Math.abs(b.index - match.index) < 20
          );
          if (!existingAtSamePos || marker.priority < existingAtSamePos.priority) {
            if (existingAtSamePos) {
              const idx = boundaries.indexOf(existingAtSamePos);
              boundaries[idx] = {
                type: marker.type,
                index: match.index,
                matchLength: match[0].length,
                priority: marker.priority,
              };
            } else {
              boundaries.push({
                type: marker.type,
                index: match.index,
                matchLength: match[0].length,
                priority: marker.priority,
              });
            }
          }
        }
      }
    }

    return boundaries.sort((a, b) => a.index - b.index);
  }

  private buildSectionsFromBoundaries(
    text: string,
    boundaries: BoundaryMatch[]
  ): DocumentSection[] {
    const sections: DocumentSection[] = [];
    const maxLength = 50000;

    if (boundaries.length === 0) {
      return sections;
    }

    // Header: everything before first boundary
    if (boundaries[0].index > 50) {
      sections.push({
        type: SectionType.HEADER,
        text: text.substring(0, boundaries[0].index).trim(),
        start_index: 0,
        end_index: boundaries[0].index,
        confidence: 0.85,
      });
    }

    // Build sections from boundary pairs
    for (let i = 0; i < boundaries.length; i++) {
      const start = boundaries[i].index;
      const nextStart = i + 1 < boundaries.length ? boundaries[i + 1].index : text.length;
      const end = Math.min(nextStart, start + maxLength);

      const sectionText = text.substring(start, end);
      if (sectionText.trim().length < 10) continue;

      sections.push({
        type: boundaries[i].type,
        text: sectionText,
        start_index: start,
        end_index: end,
        confidence: 0.8,
      });
    }

    return sections;
  }

  private extractAmountSections(
    text: string,
    existingSections: DocumentSection[]
  ): DocumentSection[] {
    const amountSections: DocumentSection[] = [];

    for (const pattern of AMOUNT_PATTERNS) {
      const freshPattern = new RegExp(pattern.source, pattern.flags);
      let match;
      while ((match = freshPattern.exec(text)) !== null) {
        const contextStart = Math.max(0, match.index - 100);
        const contextEnd = Math.min(text.length, match.index + match[0].length + 100);

        // Skip if this region is already inside an existing section
        const insideExisting = existingSections.some(
          (s) => match!.index >= s.start_index && match!.index < s.end_index
        );
        if (insideExisting) continue;

        // Skip if overlapping with already-found amount sections
        const overlaps = amountSections.some(
          (s) =>
            (contextStart >= s.start_index && contextStart < s.end_index) ||
            (contextEnd > s.start_index && contextEnd <= s.end_index)
        );
        if (overlaps) continue;

        amountSections.push({
          type: SectionType.AMOUNTS,
          text: text.substring(contextStart, contextEnd),
          start_index: contextStart,
          end_index: contextEnd,
          confidence: 0.75,
        });
      }
    }

    return amountSections;
  }

  private calculateConfidence(section: DocumentSection, _fullText: string): number {
    let confidence = section.confidence;

    // Boost for longer, meaningful sections
    if (section.text.length >= 200 && section.text.length <= 30000) {
      confidence += 0.1;
    }

    // Reduce confidence for very short sections
    if (section.text.length < 50) {
      confidence -= 0.2;
    }

    // Reduce confidence for extremely long sections (possible parsing issue)
    if (section.text.length > 40000) {
      confidence -= 0.1;
    }

    // Boost for HEADER if it contains court name patterns
    if (section.type === SectionType.HEADER) {
      if (/суд/i.test(section.text) && /справ[аи]/i.test(section.text)) {
        confidence += 0.1;
      }
    }

    // Boost for DECISION if it contains operative keywords
    if (section.type === SectionType.DECISION) {
      if (/стягнути|відмовити|задовольнити|скасувати/i.test(section.text)) {
        confidence += 0.1;
      }
    }

    return Math.min(1.0, Math.max(0.0, confidence));
  }

  private async llmAssistedExtraction(text: string): Promise<DocumentSection[]> {
    if (!this.llm) {
      return [];
    }

    try {
      const response = await this.llm.chatCompletion(
        {
          messages: [
            {
              role: 'system',
              content: `Ти експерт з аналізу юридичних документів. Розбий текст на семантичні секції:
- HEADER: Шапка документа (суд, номер справи, дата, склад суду)
- FACTS: Фактичні обставини (після ВСТАНОВИВ)
- CLAIMS: Позовні вимоги
- PROCEDURAL_HISTORY: Короткий зміст рішень попередніх інстанцій
- LAW_REFERENCES: Посилання на норми права (окремий розділ)
- MOTIVES: Мотивувальна частина
- COURT_REASONING: Висновки суду
- DECISION: Резолютивна частина
- AMOUNTS: Суми, штрафи, компенсації

Поверни JSON масив з об'єктами: { type, text, start_index, end_index, confidence }`,
            },
            {
              role: 'user',
              content: text.substring(0, 8000),
            },
          ],
          temperature: 0.2,
          max_tokens: 2000,
          response_format: { type: 'json_object' },
        },
        'deep'
      );

      // Strip markdown code fences (```json ... ```) that some models wrap around JSON
      let rawContent = response.content || '{}';
      rawContent = rawContent.replace(/^[\s\n]*```(?:json)?\s*\n?/i, '').replace(/\n?\s*```[\s\n]*$/i, '');
      const result = JSON.parse(rawContent);
      return (result.sections || []).map((s: any) => ({
        type: s.type as SectionType,
        text: s.text,
        start_index: s.start_index || 0,
        end_index: s.end_index || s.text.length,
        confidence: s.confidence || 0.7,
      }));
    } catch (error) {
      logger.error('LLM-assisted extraction error:', error);
      return [];
    }
  }
}
