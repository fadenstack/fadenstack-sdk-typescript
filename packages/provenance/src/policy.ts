import type { ProvenancePolicy } from "@fadenstack/client";

/**
 * The server's policy, tightened by the integrator's local options: a local option may only make marking stricter
 * (refuse rather than record, a lower short-text threshold, fewer exempt edit kinds, a visible label). What would
 * loosen it is ignored, and `ignored` is told what.
 */
export function tightenPolicy(
  server: Required<ProvenancePolicy>,
  local: ProvenancePolicy | undefined,
  ignored: (message: string) => void = () => undefined,
): Required<ProvenancePolicy> {
  if (!local) return server;
  const policy = { ...server, exempt_edit_kinds: [...server.exempt_edit_kinds] };
  if (local.on_missing === "refuse") policy.on_missing = "refuse";
  else if (local.on_missing === "record" && server.on_missing === "refuse") ignored("on_missing 'record': the server's policy refuses.");
  if (local.short_text_tokens !== undefined) {
    if (local.short_text_tokens <= server.short_text_tokens) policy.short_text_tokens = Math.max(0, local.short_text_tokens);
    else ignored(`short_text_tokens ${local.short_text_tokens}: the server's threshold is ${server.short_text_tokens}.`);
  }
  if (local.exempt_edit_kinds) {
    const looser = local.exempt_edit_kinds.filter((k) => !server.exempt_edit_kinds.includes(k));
    if (looser.length) ignored(`exempt_edit_kinds ${looser.join(", ")}: the server's policy marks them.`);
    policy.exempt_edit_kinds = server.exempt_edit_kinds.filter((k) => local.exempt_edit_kinds!.includes(k));
  }
  if (local.internal_technical === false) policy.internal_technical = false;
  else if (local.internal_technical === true && !server.internal_technical) ignored("internal_technical: only the server's policy can set it.");
  if (local.visible_label === true) policy.visible_label = true;
  else if (local.visible_label === false && server.visible_label) ignored("visible_label false: the server's policy asks for a label.");
  if (local.output_log === true) policy.output_log = true;
  else if (local.output_log === false && server.output_log) ignored("output_log false: the server's policy keeps the output log.");
  return policy;
}
