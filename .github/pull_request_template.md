## What and why

<!-- One or two sentences. Link the ticket. -->

## Checklist

- [ ] Small change, branch less than a day old
- [ ] Tests added or updated (unit / contract / smoke)
- [ ] API or event contract changed? Additive only, or a new version (`v2`) with the old one kept
- [ ] Database change is backward compatible (expand / contract) so old and new versions can run side by side
- [ ] No secrets, personal data or card data in code or logs
- [ ] New behaviour behind a feature flag if it is not ready for customers
- [ ] Runbook / ADR updated if operations or architecture changed
