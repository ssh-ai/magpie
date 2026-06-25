# Provider-compliance constraints (Anthropic / OpenAI)

Switchboard moves messages between independently-operated agents. To stay on the
right side of provider terms, the system is built around one principle and one
hard exclusion. These are load-bearing — do not "improve" them away.

## The principle: each agent uses its OWN owner's OWN authentication

> Every agent runs on its owner's own account/credentials, for that owner's own
> purpose. My Claude = my login/my key. Your Claude = your account. Codex = your
> OpenAI account. **Switchboard never touches, stores, extracts, forwards, or
> shares any provider token.** It only relays end-to-end-encrypted message bytes.

Because each side authenticates itself, all of these are allowed and work
cross-vendor — a provider only cares that *its own* account is used by *its own*
owner, and is indifferent to (and unaware of) what the other end is:

- Claude (my account) ↔ Claude (your account) ✅
- Claude ↔ Codex (your OpenAI account) ✅
- Claude ↔ Gemini, or any mix ✅

Driving the **official** agent CLI for automation is explicitly fine: Anthropic
documents scripted/automated Claude Code use (CI/CD). The auto-attendant spawns
the real `claude -p` / `codex exec` / `gemini -p` binaries — it does **not** wrap
an OAuth flow or extract a token.

## The hard exclusion (mode ③): a human driving someone else's agent on the other person's seat

**Excluded.** Letting User A's prompts run on User B's subscription/seat is
effectively credential/seat sharing, which both providers prohibit:

- **Anthropic (Consumer Terms, clarified Feb 2026):** subscription (Free/Pro/Max)
  OAuth tokens are for Claude Code & Claude.ai only; using them in any other
  product/tool/service, or extracting/sharing them, violates the Consumer ToS.
  Anthropic actively blocked third-party clients (OpenClaw, etc.) that rode a
  user's subscription via shared session tokens.
- **OpenAI (Services Agreement):** customers must not share account access or
  login credentials between users, and may not resell or lease access to their
  account or any end-user account.

So Switchboard supports **mode ② only** (agent ↔ agent, each on its own auth),
plus **mode ①** (a human talking to their *own* agent). It does **not** offer a
"talk directly to the other person's agent" feature.

## SaaS / hosted implications

A hosted Switchboard must use **API-key authentication** (Anthropic Commercial
Terms / OpenAI API), not users' consumer-subscription OAuth:

- **Bring-your-own-key:** each user supplies their own API key, or runs their own
  agent CLI locally (the agent authenticates itself; the relay stays auth-blind).
- A hosted relay/MCP must never require or proxy a user's Pro/Max/Plus
  subscription OAuth.

## Invariant for reviewers

Any change that makes the relay, MCP server, or adapters read, store, forward, or
depend on a provider auth token — or that routes one user's model usage onto
another user's account — is a compliance regression and must be rejected.

Sources: [Anthropic — Updating our Usage Policy](https://www.anthropic.com/news/updating-our-usage-policy),
[Anthropic — Updates to Consumer Terms](https://www.anthropic.com/news/updates-to-our-consumer-terms),
[Claude Code ToS analysis](https://autonomee.ai/blog/claude-code-terms-of-service-explained/),
[OpenAI Services Agreement](https://openai.com/policies/services-agreement/).
