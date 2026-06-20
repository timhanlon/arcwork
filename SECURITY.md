# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Report them privately via [GitHub's private vulnerability reporting](https://github.com/timhanlon/arcwork/security/advisories/new),
or by email to accounts@twofutures.co.

You'll get an acknowledgement, and we'll work with you on a fix and disclosure
timeline before anything is made public.

## Scope

Arc Work runs local agent CLIs and stores conversation/workspace state locally. It is
distributed source-only and runs on the developer's own machine. Of particular
interest:

- Handling of local credentials and provider tokens
- The MCP stdio/HTTP proxy seam
- Anything that could let a project's files or an agent escape its intended scope
