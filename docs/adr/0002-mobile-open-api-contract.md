# ADR-0002: Keep the API usable by a client that is not a browser

- **Status:** Accepted
- **Date:** 2026-09-07
- **Stage:** 01

## Context

Nook's client today is a React web application. A mobile client is a real
possibility later, and the comparison in the roadmap concluded that Flutter is
the better choice *if* mobile becomes a product — while being the wrong choice
for these fifteen weeks, because it would add three to five weeks of
application work to a project where application work is already the main risk.

That leaves a question that has to be answered now rather than later: how much
does it cost to keep the option open, and what does it cost to close it by
accident?

Closing it by accident is easy and usually invisible. An API becomes web-only
one convenience at a time — a session cookie here, a server-rendered fragment
there — and the discovery happens months later, when someone tries to write a
second client and finds the API assumes a browser.

## Decision

The API is built so that the web client is one consumer of it, never a
privileged one. Concretely:

**Bearer tokens, not session cookies.** A cookie is set and sent by a browser
automatically, which drags in CSRF defences, `SameSite` semantics and an
origin model that a native client cannot participate in. A bearer token is a
string; anything that can set a header can use it.

**No server-rendered coupling.** The API returns JSON. It does not know that a
React application exists.

**The OpenAPI document is generated from the same Zod schemas the server
validates with.** One definition drives runtime validation, TypeScript types
and the published spec, so the document cannot drift from the implementation.
A hand-written spec is a description of what someone believed the API did.

**The WebSocket protocol is documented as deliberately as the REST one.**
Message types, framing, the authentication mechanism, and the connection
sequence — including the fact that a client must send its own sync step 1 or
it will silently receive nothing written before it connected. That last point
was a real bug in this codebase, found only because a test connected to a
document that already had content.

**Contract tests in CI (stage 05).** The generated document is published as a
build artifact and diffed against the previous release, so a breaking change
fails a build rather than a future mobile release.

## Consequences

### Better

- Every item above is ordinary good practice regardless of whether mobile ever
  happens: versioned contracts, CI-enforced compatibility, a clean auth
  boundary, no hidden coupling between client and server.
- The decision point moves to after week 15, when the platform is real and the
  requirements for mobile are known rather than guessed.
- If Flutter does happen, it becomes a sixteenth stage with genuinely
  interesting CI work — signing, provisioning profiles, a macOS runner, staged
  store rollout — rather than a rewrite.

### Worse

- **Bearer tokens in a browser are a real trade, not a free win.** A token in
  `sessionStorage` is readable by any script running on the page, so a
  cross-site scripting bug becomes a token theft. An `HttpOnly` cookie is not.
  The mitigation is that XSS is fatal either way — an attacker with script
  execution can simply make authenticated requests — but the honest position is
  that this choice trades a browser-specific defence for portability.
- Token lifetime and revocation are now this system's problem. Twelve-hour
  tokens with no revocation list is the current, deliberate simplification;
  a compromised token is valid until it expires.
- The WebSocket authentication uses the `Sec-WebSocket-Protocol` header, which
  is a documented abuse of subprotocol negotiation. It is what most production
  systems settle on, because browsers cannot set an `Authorization` header on a
  WebSocket handshake and a token in the query string lands in access logs. It
  is still not what the field was designed for.
- Maintaining a published contract is work. It has to be regenerated, reviewed
  in diffs, and occasionally argued about.

## What would change this

- **If mobile is definitively ruled out** — no second client, ever — the cookie
  approach becomes better on security grounds alone, and this ADR should be
  reversed rather than carried out of habit.
- **If a security review requires `HttpOnly` cookies** for the web client, the
  answer is likely both: cookies for the browser, bearer tokens for other
  clients, with one auth module serving both. That is more code and a second
  path to test, which is why it is not the starting point.
- **If token theft becomes a real incident**, short-lived access tokens with
  refresh rotation replace the current twelve-hour token. That is a contained
  change to the auth module and the client, not an architectural one.
- **If the WebSocket subprotocol mechanism causes trouble** with a proxy or a
  CDN that rewrites the header, the fallback is a short-lived ticket fetched
  over HTTP and exchanged at connect time. More correct, one more round trip
  and a store to run.
