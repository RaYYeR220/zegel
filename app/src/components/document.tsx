import type { ReactNode } from 'react';

/**
 * The furniture every page of the booklet shares.
 *
 * A travel document is recognisable before it is read: the crest, the two-language
 * field labels, the guilloche under the type, the hairline of microprint. These
 * components are that recognition, and they carry no data of their own.
 */

export function Guilloche(): ReactNode {
  return (
    <div className="guilloche" aria-hidden="true">
      <span className="ros a" />
      <span className="ros b" />
      <span className="ros c" />
    </div>
  );
}

export function Laminate(): ReactNode {
  return <div className="laminate" aria-hidden="true" />;
}

const MICRO = 'DE NAAM IS OPENBAAR DE PORTEFEUILLE IS GEHEIM THE NAME IS PUBLIC THE WALLET IS THE SECRET ';

export function Microprint(): ReactNode {
  return (
    <div className="microprint" aria-hidden="true">
      {MICRO.repeat(33)}
    </div>
  );
}

export function Crest(): ReactNode {
  return (
    <svg width="52" height="52" viewBox="0 0 52 52" aria-hidden="true">
      <circle cx="26" cy="26" r="24" fill="none" stroke="#123A6B" strokeWidth="1.4" />
      <circle cx="26" cy="26" r="20" fill="none" stroke="#7E93AE" strokeWidth=".7" />
      <circle cx="26" cy="26" r="16.5" fill="none" stroke="#7E93AE" strokeWidth=".7" />
      <path d="M15 17h22L17 35h20" fill="none" stroke="#123A6B" strokeWidth="3" strokeLinejoin="miter" />
      <path d="M26 1.6v5M26 45.4v5M1.6 26h5M45.4 26h5" stroke="#123A6B" strokeWidth="1.4" />
    </svg>
  );
}

export interface PageHeadProps {
  title: string;
  subtitle: string;
  page: string;
  pageName: string;
}

export function PageHead({ title, subtitle, page, pageName }: PageHeadProps): ReactNode {
  return (
    <>
      <div className="pagehead">
        <div className="crest">
          <Crest />
          <div>
            <h1 className="ttl">{title}</h1>
            <div className="sub">{subtitle}</div>
          </div>
        </div>
        <div className="pageno">
          Bladzijde / Page
          <b>{page}</b>
          <span>{pageName}</span>
        </div>
      </div>
      <Microprint />
    </>
  );
}

export function SectionHead({ nl, en }: { nl: string; en: string }): ReactNode {
  return (
    <h2 className="sectionhead">
      {nl} <span>/ {en}</span>
    </h2>
  );
}

export interface FieldProps {
  nl: string;
  en: string;
  value: ReactNode;
  note?: ReactNode;
  span?: boolean;
  tone?: 'plain' | 'mono' | 'big' | 'blue' | 'orange' | 'grey';
}

export function Field({ nl, en, value, note, span, tone = 'plain' }: FieldProps): ReactNode {
  const cls = ['fval', tone === 'plain' ? '' : tone].filter(Boolean).join(' ');
  return (
    <div className={span === true ? 'field span' : 'field'}>
      <span className="flab">
        {nl} <span className="en">/ {en}</span>
      </span>
      <span className={cls}>{value}</span>
      {note !== undefined && <span className="fnote">{note}</span>}
    </div>
  );
}

export function FieldGrid({ children, one }: { children: ReactNode; one?: boolean }): ReactNode {
  return <div className={one === true ? 'fieldgrid one' : 'fieldgrid'}>{children}</div>;
}

/**
 * The window.
 *
 * Every identity document has one, and every other one fills it with the single
 * datum that opens everything behind it. Here it is hatched and empty, and the
 * caption says so in both languages. It is not a missing image and not a printing
 * fault: it is the whole argument, rendered as a picture.
 */
export function WithheldWindow({
  caption = 'Portefeuille / Wallet',
  mark = ['Portefeuille', 'niet afgebeeld'],
  stamp = 'wallet withheld',
  under = 'niet opgenomen in dit document',
}: {
  caption?: string;
  mark?: readonly [string, string];
  stamp?: string;
  under?: string;
}): ReactNode {
  return (
    <div>
      <div className="window">
        <div className="windowinner hatched">
          <div className="windowmark">
            {mark[0]}
            <br />
            {mark[1]}
          </div>
        </div>
      </div>
      <div className="windowcap">
        {caption}
        <b>{stamp}</b>
        {under}
      </div>
    </div>
  );
}

export function Footrule({ nl, en }: { nl: string; en: string }): ReactNode {
  return (
    <div className="footrule">
      <span>{nl}</span>
      <span>{en}</span>
    </div>
  );
}

export function Notice({
  title,
  children,
  tone = 'plain',
}: {
  title?: string;
  children: ReactNode;
  tone?: 'plain' | 'warn' | 'dim';
}): ReactNode {
  return (
    <div className={tone === 'plain' ? 'notice' : `notice ${tone}`}>
      {title !== undefined && <b>{title}</b>}
      {children}
    </div>
  );
}

export interface MrzProps {
  line1: string;
  line2: string;
  caption?: string;
  footnote?: ReactNode;
  status?: ReactNode;
}

export function Mrz({ line1, line2, caption, footnote, status }: MrzProps): ReactNode {
  return (
    <div className="mrz">
      <div className="mrzcap">
        {caption ?? 'Machineleesbare zone'} <span style={{ opacity: 0.6 }}>/ Machine-readable zone</span>
      </div>
      <div className="mrzlines">
        <div>{line1 === '' ? ' ' : line1}</div>
        <div>{line2 === '' ? ' ' : line2}</div>
      </div>
      {(footnote !== undefined || status !== undefined) && (
        <div className="footrule" style={{ borderTop: 0, marginTop: 6, paddingTop: 0 }}>
          <span>{footnote}</span>
          <span>{status}</span>
        </div>
      )}
    </div>
  );
}

export function Stamp({
  nl,
  en,
  sub,
  tone = 'blue',
}: {
  nl: string;
  en: string;
  sub: ReactNode;
  tone?: 'blue' | 'bad' | 'grey';
}): ReactNode {
  return (
    <div className={tone === 'blue' ? 'bigstamp' : `bigstamp ${tone}`}>
      <span className="nl">{nl}</span>
      <span className="en">{en}</span>
      <span className="st">{sub}</span>
    </div>
  );
}
