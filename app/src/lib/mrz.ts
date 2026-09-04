/**
 * A real ICAO 9303 TD3 machine-readable zone, printed from a real reference.
 *
 * Two lines of forty-four characters with the genuine 7-3-1 weighting, because
 * an MRZ that does not check is a picture of an MRZ. Every field is filled from
 * something the envelope already publishes — nothing here is invented, and
 * nothing here is secret: the zone carries the reference id, the window, the
 * expiry and a prefix of the commitment, which is exactly the set a tier-0
 * reader is entitled to.
 *
 * The wallet does not appear. That is not an oversight; it is the document.
 */

export const MRZ_LINE_LENGTH = 44;

/** The issuing authority is a namespace, not a state. `ENS` is the truthful three letters. */
export const ISSUING_NAMESPACE = 'ENS';

/** `P` for a passport-class booklet, `Z` for Zegel. */
export const DOCUMENT_CODE = 'PZ';

export interface MrzRow {
  /** Dutch label, matching the document furniture. */
  field: string;
  /** English label. */
  fieldEn: string;
  /** The characters the digit was computed over, as printed. */
  value: string;
  /** Plain-English rendering of the same value, when it has one. */
  readable?: string;
  /** The digit printed on the line. */
  printed: string;
  /** The digit recomputed from the printed characters at inspection time. */
  recomputed: string;
}

export interface Mrz {
  line1: string;
  line2: string;
  rows: MrzRow[];
  /** True when every printed check digit survives recomputation. */
  wellFormed: boolean;
}

export interface MrzInput {
  /** The public ENS name, when there is one. Never an address. */
  name: string | null;
  /** 32-byte hex reference id. */
  referenceId: string;
  /** sha256 of the canonical claim set. */
  commitment: string;
  /** ISO — start of the evidence window. */
  recordFrom: string;
  /** ISO — when the reference stops being valid. */
  expiresAt: string;
  tier: 1 | 2;
}

const FILLER = '<';

/** ICAO 9303: digits are their value, A-Z are 10-35, the filler is zero. */
export function charValue(c: string): number {
  if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48;
  if (c >= 'A' && c <= 'Z') return c.charCodeAt(0) - 55;
  return 0;
}

/** The 7-3-1 weighted modulo-10 check digit. */
export function checkDigit(input: string): string {
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < input.length; i += 1) {
    sum += charValue(input.charAt(i)) * (weights[i % 3] as number);
  }
  return String(sum % 10);
}

export function pad(value: string, length: number): string {
  const upper = value.toUpperCase().replace(/[^A-Z0-9<]/g, FILLER);
  return upper.length >= length ? upper.slice(0, length) : upper + FILLER.repeat(length - upper.length);
}

/** ISO date to the YYMMDD an MRZ carries. */
export function yymmdd(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '<<<<<<';
  const y = String(date.getUTCFullYear() % 100).padStart(2, '0');
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

const MONTHS_NL = ['JAN', 'FEB', 'MRT', 'APR', 'MEI', 'JUN', 'JUL', 'AUG', 'SEP', 'OKT', 'NOV', 'DEC'];

export function documentDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'ONBEKEND';
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${day} ${MONTHS_NL[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

const hexBody = (value: string): string => value.replace(/^0x/i, '').toUpperCase();

/**
 * Document number: `ZGL` plus six hex characters of the reference id.
 *
 * Nine characters because that is the field width, and derived rather than
 * sequential because a counter would tell an observer how many references exist.
 */
export function documentNumber(referenceId: string): string {
  return `ZGL${hexBody(referenceId).slice(0, 6)}`.slice(0, 9);
}

/** The optional-data field carries the tier and a prefix of the commitment. */
export function personalNumber(commitment: string, tier: 1 | 2): string {
  return pad(`T${tier}${hexBody(commitment).slice(0, 12)}`, 14);
}

/** The name field: the public name, or an anonymous reference when none is set. */
export function nameField(name: string | null): string {
  const holder = name === null ? 'ZEGEL' : name.toUpperCase().replace(/\./g, FILLER);
  return pad(`${holder}<<REFERENTIE`, 39);
}

export function buildMrz(input: MrzInput): Mrz {
  const line1 = pad(`${DOCUMENT_CODE}${ISSUING_NAMESPACE}${nameField(input.name)}`, MRZ_LINE_LENGTH);

  const docNo = pad(documentNumber(input.referenceId), 9);
  const from = yymmdd(input.recordFrom);
  const expiry = yymmdd(input.expiresAt);
  const personal = personalNumber(input.commitment, input.tier);

  const dDoc = checkDigit(docNo);
  const dFrom = checkDigit(from);
  const dExpiry = checkDigit(expiry);
  const dPersonal = checkDigit(personal);

  const composite = `${docNo}${dDoc}${from}${dFrom}${expiry}${dExpiry}${personal}${dPersonal}`;
  const dComposite = checkDigit(composite);

  // The sex field has no counterpart here, so it stays filler. A reference makes
  // assertions about a record, never about a person.
  const line2 = `${docNo}${dDoc}${ISSUING_NAMESPACE}${from}${dFrom}${FILLER}${expiry}${dExpiry}${personal}${dPersonal}${dComposite}`;

  const rows: MrzRow[] = [
    {
      field: 'Documentnummer',
      fieldEn: 'Document number',
      value: docNo,
      readable: `referentie ${input.referenceId.slice(0, 12)}…`,
      printed: dDoc,
      recomputed: checkDigit(docNo),
    },
    {
      field: 'Begin van de vastlegging',
      fieldEn: 'Record begins',
      value: from,
      readable: documentDate(input.recordFrom),
      printed: dFrom,
      recomputed: checkDigit(from),
    },
    {
      field: 'Geldig tot',
      fieldEn: 'Date of expiry',
      value: expiry,
      readable: documentDate(input.expiresAt),
      printed: dExpiry,
      recomputed: checkDigit(expiry),
    },
    {
      field: 'Verzegelingsnummer',
      fieldEn: 'Commitment prefix',
      value: personal,
      readable: `niveau ${input.tier} · ${input.commitment.slice(0, 14)}…`,
      printed: dPersonal,
      recomputed: checkDigit(personal),
    },
    {
      field: 'Samengesteld controlecijfer',
      fieldEn: 'Composite check',
      value: 'velden 1-10, 14-20, 22-43',
      printed: dComposite,
      recomputed: checkDigit(composite),
    },
  ];

  return {
    line1,
    line2,
    rows,
    wellFormed: rows.every((row) => row.printed === row.recomputed) && line2.length === MRZ_LINE_LENGTH,
  };
}

/**
 * The check-digit ladder, recomputed from a line exactly as printed.
 *
 * This is what an inspection desk actually does, and it is deliberately weaker
 * than it looks: a forger gets the 7-3-1 weights right without effort. All these
 * five digits establish is that the line was printed correctly. Whether its
 * contents are true is settled further down the page, by re-deriving them.
 */
export function ladderFromLine2(line2: string): MrzRow[] {
  if (line2.length !== MRZ_LINE_LENGTH) return [];

  const docNo = line2.slice(0, 9);
  const from = line2.slice(13, 19);
  const expiry = line2.slice(21, 27);
  const personal = line2.slice(28, 42);
  const composite = `${docNo}${line2.slice(9, 10)}${from}${line2.slice(19, 20)}${expiry}${line2.slice(27, 28)}${personal}${line2.slice(42, 43)}`;

  const readable = (yy: string): string => {
    const year = Number(yy.slice(0, 2));
    const month = Number(yy.slice(2, 4));
    const day = Number(yy.slice(4, 6));
    if (!Number.isFinite(year) || month < 1 || month > 12) return yy;
    // Two digits, so a century has to be assumed. A reference is never issued
    // against a record that begins in the future, so the past wins.
    const full = 2000 + year;
    return documentDate(`${full}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00Z`);
  };

  return [
    {
      field: 'Documentnummer',
      fieldEn: 'Document number',
      value: docNo,
      printed: line2.slice(9, 10),
      recomputed: checkDigit(docNo),
    },
    {
      field: 'Begin van de vastlegging',
      fieldEn: 'Record begins',
      value: from,
      readable: readable(from),
      printed: line2.slice(19, 20),
      recomputed: checkDigit(from),
    },
    {
      field: 'Geldig tot',
      fieldEn: 'Date of expiry',
      value: expiry,
      readable: readable(expiry),
      printed: line2.slice(27, 28),
      recomputed: checkDigit(expiry),
    },
    {
      field: 'Verzegelingsnummer',
      fieldEn: 'Commitment prefix',
      value: personal,
      printed: line2.slice(42, 43),
      recomputed: checkDigit(personal),
    },
    {
      field: 'Samengesteld controlecijfer',
      fieldEn: 'Composite check',
      value: 'velden 1-10, 14-20, 22-43',
      printed: line2.slice(43, 44),
      recomputed: checkDigit(composite),
    },
  ];
}

/**
 * Recompute the digits from a line as printed.
 *
 * Used at the inspection desk: the point of the exercise is that check digits
 * only prove the line was printed correctly, never that its contents are true.
 */
export function readMrzLine2(line2: string): { fields: Record<string, string>; ok: boolean } {
  if (line2.length !== MRZ_LINE_LENGTH) return { fields: {}, ok: false };
  const docNo = line2.slice(0, 9);
  const dDoc = line2.slice(9, 10);
  const from = line2.slice(13, 19);
  const dFrom = line2.slice(19, 20);
  const expiry = line2.slice(21, 27);
  const dExpiry = line2.slice(27, 28);
  const personal = line2.slice(28, 42);
  const dPersonal = line2.slice(42, 43);
  const dComposite = line2.slice(43, 44);
  const composite = `${docNo}${dDoc}${from}${dFrom}${expiry}${dExpiry}${personal}${dPersonal}`;

  return {
    fields: { docNo, from, expiry, personal },
    ok:
      checkDigit(docNo) === dDoc &&
      checkDigit(from) === dFrom &&
      checkDigit(expiry) === dExpiry &&
      checkDigit(personal) === dPersonal &&
      checkDigit(composite) === dComposite,
  };
}
