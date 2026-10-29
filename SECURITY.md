# Security

## Reporting a vulnerability

Do not report security vulnerabilities in public issues, pull requests or
discussions.

Report them privately through GitHub private vulnerability reporting: open
this repository's security tab on GitHub and choose **Report a
vulnerability**. Only you and the maintainers can see the report, and the
maintainers follow up there.

Include:

- the affected package and its version, or the commit you tested;
- steps or code that reproduce the issue;
- the impact: what an attacker can do, and under which conditions.

## Scope

Both packages in this repository, `@qbit-oss/protocol` and `@qbit-oss/api`, are in
scope. Report issues in qbit Core as its
[security policy](https://github.com/Qbit-Org/qbit/blob/main/SECURITY.md)
describes, and issues in `@qbit-oss/pqc` through
[Qbit-Org/qbit-pqc](https://github.com/Qbit-Org/qbit-pqc/blob/main/SECURITY.md).

## Supported versions

The latest published release line is supported. A fix ships as a patch release
on that line, or as the next minor release when it makes the packages reject
input they used to accept, which [RELEASING.md](RELEASING.md) counts as a
breaking change below 1.0.

## Security boundaries

`@qbit-oss/protocol` contains consensus-facing serialization, descriptor, address,
and PSBT helpers. Changes to protocol behavior must be covered by qbit Core
conformance vectors before release.

This repo does not currently own private-key custody. Future wallet-core or
keyring packages must document their storage boundaries and must not rely on
protocol helpers to protect secrets.
