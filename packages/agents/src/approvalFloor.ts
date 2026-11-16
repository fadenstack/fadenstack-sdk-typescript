/**
 * The approval floor, "the never-skip list": what no tool mode skips, not `auto` and not `bypass`. Bypass skips questions,
 * never rules (sdk/38 §4.3; sdk/51 F08 §2, owner, 16 Nov). This records the rule the SDK and the gateway already follow; it
 * changes no behaviour. Each key names one item, its value is the item's id, and `neverSkipped` lists the ids in the order of
 * sdk/38 §4.3. Tests per level (ask, auto, bypass) hold each item to it (`approvalFloor.test.ts`).
 *
 * OWASP ASVS 5.0 V8 (authorization in a trusted layer) and OWASP Top 10 for LLM Applications 2025, LLM06 (excessive agency):
 * a rule or a human approval for high-impact actions holds whatever level the person chose.
 */
export const ApprovalFloor = Object.freeze({
  /**
   * Deny rules, and hidden or refused tools (sdk/38 §4.3, "Hidden and refused tools, deny rules"). They stay hidden or refused
   * at every level: the call does not run and nobody is asked. Bypass skips questions, never rules.
   */
  refused: "refused",

  /**
   * An administrator's "Ask first" rule (sdk/38 §4.3, "Admin rules"). The gateway marks the call `rule: true`
   * (`ApprovalRequest.requiredByRule`); the person is asked at every level, whatever they allowed for the chat or always, and
   * under a Bypass grant.
   */
  askFirstRule: "ask_first_rule",

  /**
   * The author's `approval: always` in the tool contract (sdk/38 §4.3, "The agent's own ask rule"). The call asks every time, at
   * every level, like an administrator's rule.
   */
  authorAlways: "author_always",

  /**
   * A tool that acts in the physical world (sdk/38 §4.3, `physical`): it asks per call, unless an EE administrator allows it for
   * that agent. Not marked yet: see `notMarkedYet`.
   */
  physical: "physical",

  /**
   * An open-world tool in a turn that read untrusted content (sdk/38 §4.3, `open_world` in a tainted turn). Not marked yet: see
   * `notMarkedYet`.
   */
  openWorldTainted: "open_world_tainted",

  /**
   * A question an MCP server asks the person itself (elicitation; sdk/51 F08 §2). The SDK never answers it itself, at any level.
   * This SDK's MCP client declares no elicitation capability, so a server cannot ask (.NET passes the question to the app).
   */
  mcpServerQuestion: "mcp_server_question",

  /**
   * A call the gateway holds for the person, a gateway tool's approval (`faden.approval_required` with an approval id; sdk/51 F08
   * §2). The person is asked at every level; Bypass never answers the gateway, only the server may skip its own question.
   */
  gatewayHeld: "gateway_held",

  /**
   * Destructive and unclassified calls. Not in `neverSkipped`: they ask at every level except `bypass`, which covers them only
   * where the tenant allows it, after the second sign-in (sdk/41; sdk/38 §4.3, "Grants additionally never cover"). A grant for a
   * time or for a stretch of work never covers them.
   */
  destructiveOrUnclassified: "destructive_or_unclassified",

  /**
   * The items the SDK and the gateway have no markers for yet: `physical` and `openWorldTainted` (desktop 16 F-10, intent IM-09).
   * Until then such a tool needs `approval: always` in its contract or an administrator's "Ask first" rule to be held to the
   * floor (sdk/38 §4.3, "Built").
   */
  notMarkedYet: Object.freeze(["physical", "open_world_tainted"] as const),

  /** What no level skips, in the order of sdk/38 §4.3. */
  neverSkipped: Object.freeze([
    "refused", "ask_first_rule", "author_always", "physical", "open_world_tainted", "mcp_server_question", "gateway_held",
  ] as const),
});
