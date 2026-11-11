# 05 — Local credential resolution and authenticated access

## Purpose

The user authorized a design that can look locally for credentials when necessary. Implement bounded discovery of named source credentials; do not scan unrelated folders or browser profiles. The planning task does not require reading existing secrets.

Public anonymous access is tried first where the manifest supports it. An adapter declaring required authentication may resolve its profile immediately. Authentication is for access to the requested public records; it does not expand the run into private account content or portal submission workflows.

## Resolution order

1. Explicit named profile selected by `--credential-profile` or source configuration. A configured but invalid explicit profile is an error, not a reason to try an unrelated identity.
2. Source-specific environment variables, for example `WELL_SCRAPER_NC_DEQ_USERNAME`, `WELL_SCRAPER_NC_DEQ_PASSWORD`, or `WELL_SCRAPER_NC_DEQ_API_KEY`; only providers/fields declared by that adapter are read.
3. A source-scoped entry in project `.well-scraper/credentials.local.json`.
4. A source-scoped entry in `${XDG_CONFIG_HOME:-~/.config}/well-scraper/credentials.json`.
5. A named OS credential-store provider if the user configured one; lookup uses an exact service/account key.

Do not combine a username from one provider with a password from another. Once a complete candidate is selected, invalid credentials stop that identity's attempts; a bad password must not cause cycling through stored accounts. Automatic provider search only checks these well-known files, not recursively discovered `.env`, shell history, SSH directories, or other apps' credential stores. Additional paths require explicit configuration.

Browser state is a separate origin-scoped authentication method. The profile can point to an application-owned Playwright storage-state file. Validate ownership, declared source, allowed origins, and expiry; then test access with a read-only probe. Use only that source's context. [Playwright documents that storage state can contain impersonation-capable cookies/headers and should stay out of version control](https://playwright.dev/docs/auth).

## Configuration example

This is a placeholder shape, not a claim that the Mecklenburg sources require login:

```json
{
  "profiles": {
    "nc-deq": {
      "sourceIds": ["nc-deq-gw1"],
      "allowedOrigins": ["https://edocs.deq.nc.gov"],
      "provider": "environment",
      "usernameEnv": "WELL_SCRAPER_NC_DEQ_USERNAME",
      "passwordEnv": "WELL_SCRAPER_NC_DEQ_PASSWORD",
      "storageStatePath": "~/.config/well-scraper/sessions/nc-deq.json"
    }
  }
}
```

Implement environment, local-file, and application-owned storage-state providers in v1. OS keychain integration is optional and must be tested per platform. Resolve paths explicitly in application code; do not execute shell expansion. Enforce private directory/file permissions on POSIX (0700/0600) and equivalent ACL checks if Windows support is added. Reject unsafe permissions or a path resolving outside the configured allowed locations with remediation instructions.

## Interactive login

`well-scraper auth login --source <source-id>` opens a dedicated headed context and permits manual login/MFA. Persist storage state only to the configured private session path after the source-specific authenticated-state check. This command must not create accounts or submit well/permit data.

During collection, missing/expired credentials end the affected source as `needs_auth`, checkpoint its tasks, and let other sources continue. `--interactive-auth` can pause for a bounded manual login in an attached terminal; noninteractive runs never hang awaiting input. CAPTCHA or other access challenges are logged as `blocked`; no stealth/proxy rotation or challenge-solving service is part of this design.

## Secret handling

- Do not accept passwords or tokens directly as CLI arguments, where shell history/process lists could retain them.
- Do not print secret values, cookie contents, raw auth headers, signed URL parameters, session-state paths containing personal identifiers, or complete login form data.
- Emit only source/profile identifier, provider kind, and result code. Apply redaction before console/file serialization, including nested exceptions.
- Send credentials only to exact manifest-approved origins and explicit auth redirects; strip authorization on unrelated redirects. Validate each redirect before following it.
- Separate sessions from run output; gitignore local credentials, sessions, `.env` files, and collected run data. Provide placeholder-only config examples.
- Default screenshots, HAR, video, and browser traces off on authenticated pages. An explicit local diagnostic mode must apply exclusion/redaction rules and keep restricted artifacts outside shareable outputs. Do not assume a trace is secret-free because text logs were redacted.
- Preserve public well-owner information if present in requested source data; never repeat it unnecessarily in operational logs.

`auth status --source ...` reports configured/usable/expired/missing without exposing values. `auth logout --source ...` removes only application-owned session state for that profile, leaving unrelated local credentials intact.
