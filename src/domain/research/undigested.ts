export interface DigestFacts {
  readonly kind: string;
  readonly status: string;
  readonly digestedAt: number | null;
  readonly digestedBy: string | null;
  readonly titleZh: string | null;
  readonly summaryZh: string | null;
  readonly hasBody: boolean;
}

/** 舊資料的繁中內容也算已初讀，不因缺少時間或模型紀錄而覆寫。 */
export function isUndigested(facts: DigestFacts): boolean {
  return (
    facts.kind !== 'note' &&
    facts.kind !== 'reference' &&
    (facts.status === 'included' || facts.status === 'parsed') &&
    facts.hasBody &&
    facts.digestedAt === null &&
    [facts.digestedBy, facts.titleZh, facts.summaryZh].every(
      (value) => value === null || value.trim().length === 0,
    )
  );
}
