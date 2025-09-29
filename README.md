## Background

Goal: Prevent data sitting in S3 from leaving the trust boundary, both (1) outside → in (laptops, unmanaged clients pulling from S3) and (2) inside AWS → out (EC2/Batch/Lambda shipping to external destinations like Dropbox/GDrive/random IPs).

Let’s treat data exfiltration prevention from S3 as a two-sided problem:

Outside-in (external → S3): someone on a laptop or unmanaged client trying to fetch S3 objects.

Inside-out (internal AWS resource → external destination): something running legitimately in AWS (EC2, Batch, Lambda, etc.) that has data access and then ships it to Dropbox, GDrive, a random IP, etc.

The strongest posture combines identity, network, and data controls:

 * Default-deny network design: no direct internet access unless explicitly required.

 * IAM role scoping: grant S3 read only to controlled compute, not human users.

 * Block egress or enforce mandatory inspection: all traffic leaving AWS hits a firewall/proxy.

 * Continuous auditing: CloudTrail + Macie + GuardDuty + Security Hub.

Governance: SCPs + Config rules ensure no “backdoors” (e.g. rogue buckets with public ACLs).
----

### 1. Outside-in Exfiltration (Laptop, External Clients)

#### Identity & Access Controls

* Least privilege IAM policies: ensure S3 bucket policies and IAM roles grant only the minimum required access (no s3:* wildcards, no * resources).
* Block public access: enforce “S3 Block Public Access” at the account and bucket level.
* IAM Access Analyzer: continuously scan for unintended cross-account access.

#### Network & Endpoint Controls

* Private Access Paths:
  - Use VPC endpoints (Gateway/Interface) for S3 to prevent direct internet access.
  - Block S3 access from the internet by disabling internet-routable bucket endpoints.

* Client-side enforcement:
  - Require access only via corporate VPN / secure bastions.
  - Combine with device posture controls (via SSO + conditional access).

#### Monitoring & Detection

* S3 server access logs / CloudTrail Data Events: audit all GetObject/ListBucket actions.
* GuardDuty: detects anomalous S3 access (unusual geo, spikes, Tor exit nodes).
* Macie: detects sensitive data being accessed (PII, PHI, etc.).

### Inside-out Exfiltration (EC2, Batch, Lambda → External)

#### Network Egress Controls

* VPC egress restrictions:
  - Use VPC egress-only policies: no internet gateway, only VPC endpoints.
  - No NAT or NAT Gateways with firewall rules: block all or optionally allow
    egress through inspection points.
  - AWS Network Firewall block known exfil destinations (Dropbox, GDrive, etc.) or allow-list only approved endpoints.

* Service Control Policies (SCPs): prevent creation of unrestricted internet gateways/NATs.

#### Process / Application Controls

* Job isolation:
  - Run sensitive workloads in dedicated VPCs with no egress path.
  - Use S3 VPC endpoint policies that restrict access only from approved roles/VPCs.

* Runtime guardrails:
  - EC2 Systems Manager Session Manager for shell access auditing.
  - Batch jobs in controlled compute environments with locked-down AMIs.

* Data egress proxy: force uploads through a controlled service (e.g. only to approved internal endpoints, never arbitrary external addresses).

#### Data-centric Controls

* Encryption with controlled KMS keys:
  - Grant decrypt rights only to approved principals.
  - If an insider job copies ciphertext out, it’s useless without key access.
* Tagging and classification: enforce policies via Macie + IAM conditions (e.g. only specific roles can access “sensitive=true” buckets).

* Monitoring & Detection
  - VPC Flow Logs: detect unusual outbound flows from compute nodes.
  - CloudTrail: detect abnormal job submissions or role usage.
  - GuardDuty + Security Hub: correlate suspicious patterns (e.g. large data movement + outbound traffic).
