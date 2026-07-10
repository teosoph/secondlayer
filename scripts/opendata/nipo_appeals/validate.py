"""Validation stage — every parsed record is checked BEFORE it may touch the database.

Records with errors go to rejects.ndjson and are NOT inserted.
Warnings are stored in raw.validation_warnings and the record proceeds.
"""

import re
from datetime import date
from typing import List, Tuple

from .models import DecisionItem

MIN_DECISION_TEXT_CHARS = 400
# '179/2026', '284-Н/2021'; old ukrpatent years write bare '32' / '42-Н'
ORDER_NUMBER_RE = re.compile(r"^[\w\-]+(?:/\d{4})?$")
ALLOWED_SECTIONS = {"tm", "inventions", "well_known"}
ALLOWED_SOURCES = {"nipo", "ukrpatent"}
ALLOWED_RESULTS = {"granted", "refused", "partial", None}


def _plausible_date(iso: str) -> bool:
    try:
        y = int(iso[:4])
    except (TypeError, ValueError):
        return False
    return 2000 <= y <= date.today().year + 1


def validate(item: DecisionItem) -> Tuple[List[str], List[str]]:
    """Return (errors, warnings). Any error blocks the DB write."""
    errors: List[str] = []
    warnings: List[str] = []

    if item.source not in ALLOWED_SOURCES:
        errors.append(f"unknown source: {item.source!r}")
    if item.section not in ALLOWED_SECTIONS:
        errors.append(f"unknown section: {item.section!r}")
    if not item.decision_pdf_url or not item.decision_pdf_url.startswith("http"):
        errors.append(f"bad decision_pdf_url: {item.decision_pdf_url!r}")
    if not (item.object_title or "").strip():
        errors.append("empty object_title")
    if item.result not in ALLOWED_RESULTS:
        errors.append(f"unknown result: {item.result!r}")

    if not item.decision_text or len(item.decision_text) < MIN_DECISION_TEXT_CHARS:
        errors.append(
            f"decision_text too short ({len(item.decision_text or '')} chars) — "
            "download or text extraction failed"
        )
    elif "пеляційн" not in item.decision_text:
        # content sanity: a PDF that never mentions the Appeals Chamber is a foreign
        # document (e.g. AIPPI congress resolutions matched by a '*-RES-*' filename)
        errors.append("decision_text lacks 'Апеляційна палата' marker — not a chamber decision?")

    for name, value in (("order_date", item.order_date), ("decision_date", item.decision_date)):
        if value and not _plausible_date(value):
            errors.append(f"{name} out of plausible range: {value}")

    # ── warnings (record still accepted) ────────────────────────────────────
    if not item.decision_date:
        warnings.append("missing decision_date")
    if not item.order_pdf_url:
        warnings.append("missing order pdf")
    if item.order_number and not ORDER_NUMBER_RE.match(item.order_number):
        warnings.append(f"odd order_number format: {item.order_number}")
    if not item.result:
        warnings.append("result not determined (no marker, operative part unparsed)")
    if not item.app_number:
        warnings.append("app_number not found in PDFs")
    if item.section != "inventions" and not item.appellant:
        warnings.append("appellant not extracted")
    if item.order_pdf_url and (not item.order_text or len(item.order_text) < 200):
        warnings.append("order_text short/empty")

    return errors, warnings
