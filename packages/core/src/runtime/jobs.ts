import type { JobRecord } from "../storage/repositories/types.js";

export type JobHandler = (job: JobRecord) => Promise<unknown>;
