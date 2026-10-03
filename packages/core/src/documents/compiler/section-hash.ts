import { createHash } from "node:crypto";

export interface TypedPageSectionHashInput {
  readonly sectionId: string;
  readonly heading: string;
  readonly claims: readonly {
    readonly id: string;
    readonly text: string;
    readonly evidenceRefs: readonly string[];
  }[];
}

/** Stable id/bytes/evidence hash. Order is significant; evidence is not sorted away. */
export function hashTypedPageSection(section: TypedPageSectionHashInput): string {
  const payload = {
    sectionId: section.sectionId,
    heading: section.heading,
    claims: section.claims.map((claim) => ({
      id: claim.id,
      text: claim.text,
      evidenceRefs: [...claim.evidenceRefs],
    })),
  };
  return createHash("sha256")
    .update("mengshu.typed-page-section/v1\0")
    .update(JSON.stringify(payload))
    .digest("hex");
}
