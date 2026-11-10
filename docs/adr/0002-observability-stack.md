# ADR 0002: OpenTelemetry with a managed Grafana stack for observability

* Status: Accepted
* Deciders: Lead Solutions Architect, platform team, all service teams
* Date: 2026-10-29

## Context

Today logs sit in files on two servers, there are no dashboards and no alerts,
and customers report most incidents. After the migration one checkout request
crosses several services and a broker, so the team must be able to follow a
request end to end, alert on the 99.9% checkout objective rather than on
individual machines, and do so with two operations staff and a limited budget.
Logs may contain personal data, so the data must stay in the EU (GDPR).

## Decision

Instrument every service with **OpenTelemetry** (SDKs plus an OpenTelemetry
Collector in the cluster) and send logs, metrics and traces to **Grafana Cloud
(EU region)**: Loki for logs, Prometheus-compatible metrics, Tempo for traces,
Grafana dashboards and alerting. Every log line follows the mandatory schema
(timestamp, level, service, version, env, correlation_id, trace_id, span_id,
event, message). The Collector removes personal data before export and keeps
100% of error traces but samples successful ones (tail sampling, 10%).
Dashboards and alert rules are kept as code in Git.

## Alternatives considered

| Criterion (weight) | OTel + Grafana Cloud | Self-hosted ELK + Prometheus + Jaeger | Datadog | AWS CloudWatch + X-Ray |
|---|---|---|---|---|
| Operational effort (30%) | Low (managed) | High (Elasticsearch clusters, upgrades, storage) | Low | Low |
| Cost predictability at our size (25%) | Good (usage based, free tier) | Infrastructure + staff time | Poor (per host and per GB, grows with containers) | Medium (query and ingest charges) |
| Correlating logs, metrics, traces (20%) | Strong (trace_id links) | Possible, more glue | Strong | Weaker |
| Vendor neutrality (15%) | High (OTel: change exporter, keep code) | High | Low (proprietary agents) | Low |
| EU data residency / GDPR (10%) | EU region + DPA | Full control | EU region | EU region |

## Consequences

* Positive: incidents are detected by alerts, not customers; one place to
  follow a correlation id or trace across services; switching backend later
  needs a Collector change, not code changes.
* Negative / technical debt accepted: telemetry leaves MaltaShop's account (a
  data processing agreement and PII scrubbing are mandatory); cost grows with
  log volume, so log levels and sampling need governance; dashboards are tied
  to Grafana unless kept as code.
* Revisit when: monthly observability spend exceeds an agreed share of cloud
  spend, or data-residency rules change.
