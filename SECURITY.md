# Security policy

## Reporting a vulnerability

Please tell us privately first. Do not report a security problem in a public issue, pull request or discussion.

Report it in one of these ways:

- **On GitHub:** this repository's **Security** tab, **Report a vulnerability**. Only the maintainers see the
  report.
- **Through our contact form:** <https://emagin8.de/contact?subject=Fadenstack%20security>, with the subject
  "Fadenstack security".

Describe what you found and how to reproduce it:

- the package and its version (`@fadenstack/client 0.1.0`, for example), where it runs (a browser, an extension or
  Node.js), and the server release it talks to;
- the steps, the code or a small proof of concept;
- what an attacker gains, and what they need first (an account, access to the device, access to the network).

English and German are both fine.

## What happens next

We confirm that we received your report and keep you informed while we fix it. A fix ships in a release; we then
publish a security advisory on GitHub that describes the problem and names you, if you want to be named. Please
keep the details to yourself until that release is out.

## Please don't

- test against installations you do not own or are not allowed to test;
- access, change or delete data that isn't yours;
- disrupt a service (no denial-of-service testing).

## Supported versions

Security fixes go into the latest release. Update the `@fadenstack` packages to it.

| Version | Security fixes |
| --- | --- |
| 0.1.x (latest) | Yes |
| older | No: update first |

## Scope

This policy covers this repository and the `@fadenstack` packages released from it on npm. A problem in
the server is reported the same way; its policy is in
[fadenstack/fadenstack](https://github.com/fadenstack/fadenstack/security/policy).

Our policy page on the website says the same: <https://fadenstack.com/security/#report>. The machine-readable
contact is <https://fadenstack.com/.well-known/security.txt>.
