import { redactSecrets } from "../../ingest/agent-history/redaction.js";
import { safeLabel, sha256, stableJson } from "./shared.js";
import type { SourceIssueCode, SourceParser, SourceRecord, SourceScanLimits } from "./types.js";

export interface ParsedSpan {
  spanOrEventId: string;
  contentHash: string;
  quote: string;
  context: SourceRecord["context"];
  byteStart: number;
  byteEnd: number;
  lineStart: number;
  lineEnd: number;
  observedRole?: SourceRecord["observedRole"];
  occurredAt?: number;
  redactedCount: number;
}

export interface ParseResult { span?: ParsedSpan; issue?: SourceIssueCode; counted: boolean; finished?: boolean }
interface ObjectValue { [key: string]: unknown }
const object = (value: unknown): ObjectValue | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined;
const string = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;
const role = (value: unknown): SourceRecord["observedRole"] =>
  value === "user" || value === "assistant" || value === "system" || value === "tool" ? value : undefined;

const VISIBLE_CHANNELS = new Set(["final", "commentary"]);
const VISIBLE_BLOCKS = new Set(["text", "input_text", "output_text"]);
const visibleChannel = (value: unknown) => value === undefined || typeof value === "string" && VISIBLE_CHANNELS.has(value);
const HIDDEN_ITEMS = new Set(["reasoning", "reasoning_summary", "analysis", "thinking", "redacted_thinking", "agent_reasoning"]);
const SKIPPED_BLOCKS = new Set([...HIDDEN_ITEMS, "summary_text", "tool_use", "tool_call", "image", "input_image", "image_url", "refusal"]);

function unsupportedContent(value: unknown): boolean {
  if (value === undefined || typeof value === "string") return false;
  if (!Array.isArray(value)) return true;
  return value.some(item => typeof item !== "string" && (!object(item) || !VISIBLE_BLOCKS.has(object(item)!.type as string) && !SKIPPED_BLOCKS.has(object(item)!.type as string)));
}

function textContent(value: unknown, parser: SourceParser): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  return value.map(item => {
    if (typeof item === "string") return item;
    const entry = object(item);
    if (!entry) return "";
    if (!VISIBLE_BLOCKS.has(entry.type as string) || !visibleChannel(entry.channel)) return "";
    if (parser === "claude-code-jsonl" && entry.type !== "text") return "";
    return string(entry.text) ?? "";
  }).filter(Boolean).join("\n");
}

export class SourceRecordParser {
  parser: SourceParser;
  sessionKey?: string;
  private heading: string[] = [];
  private headingTruncated: boolean[] = [];
  private before = "";
  private paragraph: string[] = [];
  private paragraphBytes = 0;
  private blockStart = 0;
  private blockLine = 1;
  private lastEnd = 0;
  private lastLine = 1;
  private oversized = false;
  private fence?: string;
  private frontmatter = false;
  private privateKey = false;
  private pending?: ParsedSpan;

  constructor(parser: SourceParser, sessionKey?: string) {
    this.parser = parser;
    this.sessionKey = sessionKey;
  }

  consume(line: string, start: number, end: number, lineNo: number, limits: SourceScanLimits): ParseResult {
    if (this.parser !== "markdown") return this.jsonl(line, start, end, lineNo, limits);
    if (line.includes("\0")) return { issue: "binary_file", counted: true };
    if (lineNo === 1 && line.trim() === "---") { this.frontmatter = true; return { counted: false }; }
    if (this.frontmatter) {
      if (line.trim() === "---" || line.trim() === "...") this.frontmatter = false;
      return { counted: false };
    }
    if (/-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----/.test(line)) this.privateKey = true;
    if (this.privateKey) {
      const ended = /-----END (?:[A-Z ]+)?PRIVATE KEY-----/.test(line);
      if (ended) this.privateKey = false;
      line = "[REDACTED:private_key]";
    }
    const heading = !this.fence && /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const result = this.flush(limits);
      const safeHeading = safeLabel(heading[2], 161);
      this.heading.length = heading[1].length - 1;
      this.headingTruncated.length = heading[1].length - 1;
      this.heading.push(safeHeading.slice(0, 160));
      this.headingTruncated.push(safeHeading.length > 160);
      this.before = "";
      return result;
    }
    const fence = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (!this.fence) this.fence = fence;
      else if (fence[0] === this.fence[0] && fence.length >= this.fence.length) this.fence = undefined;
    }
    if (!line.trim() && !this.fence) return this.flush(limits);
    if (!this.paragraph.length && !this.oversized) { this.blockStart = start; this.blockLine = lineNo; }
    this.lastEnd = end;
    this.lastLine = lineNo;
    this.paragraphBytes += Buffer.byteLength(line) + 1;
    if (this.paragraphBytes > limits.maxRecordBytes) { this.oversized = true; this.paragraph = []; }
    else if (!this.oversized) this.paragraph.push(line);
    return { counted: false };
  }

  flush(limits: SourceScanLimits): ParseResult {
    if (this.oversized) {
      this.oversized = false;
      this.paragraph = [];
      this.paragraphBytes = 0;
      const pending = this.pending;
      this.pending = undefined;
      if (pending) pending.context.incomplete = true;
      return { counted: true, issue: "record_too_large", span: pending };
    }
    if (!this.paragraph.length) return { counted: false };
    const raw = this.paragraph.join("\n").trim();
    this.paragraph = [];
    this.paragraphBytes = 0;
    const redacted = redactSecrets(raw);
    if (redacted.text.length > limits.maxSnippetChars) {
      const pending = this.pending;
      this.pending = undefined;
      if (pending) pending.context.incomplete = true;
      return { counted: true, issue: "record_too_large", span: pending };
    }
    if (!redacted.text) return { counted: true };
    const fullHeading = this.heading.filter(Boolean).join(" / ");
    const heading = fullHeading.slice(0, limits.maxContextChars);
    const contentHash = sha256(redacted.text);
    const span: ParsedSpan = {
      spanOrEventId: sha256(stableJson({ heading: fullHeading, contentHash })), contentHash,
      quote: redacted.text,
      context: { ...(heading ? { heading } : {}), ...(this.before && limits.maxContextChars ? { before: this.before.slice(-limits.maxContextChars) } : {}),
        ...(this.headingTruncated.some(Boolean) || fullHeading.length > limits.maxContextChars ? { incomplete: true } : {}) },
      byteStart: this.blockStart, byteEnd: this.lastEnd, lineStart: this.blockLine, lineEnd: this.lastLine,
      redactedCount: redacted.redactedCount + (raw.includes("[REDACTED:private_key]") ? 1 : 0),
    };
    this.before = limits.maxContextChars ? redacted.text.slice(-limits.maxContextChars) : "";
    const previous = this.pending;
    this.pending = span;
    if (previous) {
      previous.context.after = redacted.text.slice(0, limits.maxContextChars);
      if (redacted.text.length > limits.maxContextChars) previous.context.incomplete = true;
    }
    return { counted: !!previous, span: previous };
  }

  finish(limits: SourceScanLimits): ParseResult {
    if (this.paragraph.length || this.oversized) return this.flush(limits);
    const span = this.pending;
    this.pending = undefined;
    if (span && (this.frontmatter || this.fence || this.privateKey)) span.context.incomplete = true;
    return { counted: !!span, span, finished: true };
  }

  discardRecord(): void {
    if (this.parser !== "markdown") return;
    this.paragraph = [];
    this.paragraphBytes = 0;
    this.oversized = true;
    if (this.pending) this.pending.context.incomplete = true;
  }

  private jsonl(line: string, start: number, end: number, lineNo: number, limits: SourceScanLimits): ParseResult {
    if (!line.trim()) return { counted: false };
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return { counted: true, issue: "bad_json" }; }
    const value = object(parsed);
    if (!value) return { counted: true, issue: "unrecognized_jsonl" };
    const payload = object(value.payload);
    const message = object(value.message);
    if (this.parser === "auto") {
      if (["session_meta", "response_item", "event_msg"].includes(value.type as string) && payload) this.parser = "codex-jsonl";
      else if (value.uuid && value.sessionId && message && ["user", "assistant"].includes(value.type as string)) this.parser = "claude-code-jsonl";
      else if ((value.type === "session" && value.version && value.id) || (value.type === "message" && value.id && message)) this.parser = "openclaw-jsonl";
      else return { counted: true, issue: "unrecognized_jsonl" };
    }
    const nativeSession = string(value.sessionId) ?? string(value.session_id) ?? string(value.conversationId) ??
      (value.type === "session_meta" ? string(payload?.id) : undefined) ?? (value.type === "session" ? string(value.id) : undefined);
    if (nativeSession) this.sessionKey = sha256(nativeSession);
    if (["session_meta", "session", "turn_context"].includes(value.type as string)) return { counted: true };
    const body = this.parser === "codex-jsonl" ? payload ?? message ?? value : message ?? value;
    if (!visibleChannel(value.channel) || !visibleChannel(body.channel)) return { counted: true };
    if (HIDDEN_ITEMS.has(value.type as string) || HIDDEN_ITEMS.has(body.type as string)) return { counted: true };
    const allowedEnvelope = this.parser === "codex-jsonl" ? ["response_item", "event_msg", "message"]
      : this.parser === "claude-code-jsonl" ? ["user", "assistant", "message"] : ["message"];
    if (value.type !== undefined && !allowedEnvelope.includes(value.type as string)) return { counted: true, issue: "unrecognized_jsonl" };
    const codexToolOutput = this.parser === "codex-jsonl" && value.type === "response_item" && body.type === "function_call_output";
    if (this.parser === "codex-jsonl" && value.type === "response_item" && body.type !== "message" && !codexToolOutput) {
      if (["function_call", "custom_tool_call"].includes(body.type as string)) return { counted: true };
      return { counted: true, issue: "unrecognized_jsonl" };
    }
    // Do not extract tool arguments or arbitrary nested objects as user conversation.
    let observedRole = role(body.role) ?? role(value.role) ?? role(value.type);
    if (codexToolOutput || this.parser === "openclaw-jsonl" && body.role === "toolResult") observedRole = "tool";
    if (this.parser === "codex-jsonl" && value.type === "event_msg") {
      if (body.type === "user_message") observedRole = "user";
      else if (body.type === "agent_message") observedRole = "assistant";
      else return { counted: true };
    }
    const text = codexToolOutput ? textContent(body.output, this.parser)
      : textContent(body.content, this.parser) ?? (body.content === undefined ? string(body.text) ?? string(body.message) : undefined);
    const unsupported = unsupportedContent(codexToolOutput ? body.output : body.content);
    if (!observedRole || !text) return { counted: true, ...(!observedRole || unsupported || codexToolOutput ? { issue: "unrecognized_jsonl" as const } : {}) };
    const redacted = redactSecrets(text.trim());
    if (redacted.text.length > limits.maxSnippetChars) return { counted: true, issue: "record_too_large" };
    if (!redacted.text) return { counted: true };
    const rawTime = value.timestamp ?? value.createdAt ?? body.timestamp;
    let occurredAt: number | undefined;
    if (typeof rawTime === "number" && Number.isFinite(rawTime)) occurredAt = rawTime > 10_000_000_000 ? rawTime : rawTime * 1000;
    else if (typeof rawTime === "string" && Number.isFinite(Date.parse(rawTime))) occurredAt = Date.parse(rawTime);
    const nativeId = string(value.uuid) ?? string(body.id) ?? string(value.id) ?? string(value.messageId) ?? string(value.message_id) ??
      (codexToolOutput ? string(body.call_id) : undefined);
    const contentHash = sha256(redacted.text);
    const spanOrEventId = sha256(stableJson(nativeId
      ? { provider: this.parser, session: this.sessionKey, nativeId }
      : { session: this.sessionKey, observedRole, occurredAt, contentHash }));
    const span: ParsedSpan = {
      spanOrEventId, contentHash, quote: redacted.text,
      context: this.before && limits.maxContextChars ? { before: this.before.slice(-limits.maxContextChars) } : {},
      byteStart: start, byteEnd: end, lineStart: lineNo, lineEnd: lineNo,
      observedRole, occurredAt, redactedCount: redacted.redactedCount,
    };
    this.before = limits.maxContextChars ? redacted.text.slice(-limits.maxContextChars) : "";
    return { span, counted: true, ...(unsupported ? { issue: "unrecognized_jsonl" as const } : {}) };
  }
}
