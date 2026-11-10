# Host-control request failures

Host transfer/reclaim/receipt requests share a sanitized XMPP error mapper.
`service-unavailable` identifies missing protocol provisioning; authorization,
conflict, rate limit, internal service failure and no-response timeout have
distinct actionable messages. Unknown conditions fail generically.

Only standard XMPP error-condition element names are inspected. Never display
or log returned XML/text because an error may include a credential-bearing IQ.
Timeout/internal failure remains uncertain: retain pending recovery credentials
and do not claim success or start a replacement operation automatically.

Regression: `node --test tests/host-transfer-errors.test.cjs`; full suite:
`npm test`. Deployment provisioning and device acceptance are separate gates.
