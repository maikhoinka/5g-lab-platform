# 5G Lab Platform

A web-based platform for managing fiber connections and infrastructure 
in 5G test environments, replacing manual Excel-based documentation.

## 🎯 Problem
Fiber connections in 5G test environments were tracked manually in Excel 
spreadsheets, making it difficult to manage radio-switch-server topologies 
across multiple rack panels. This platform replaces that process with a 
web-based management interface.

## 🏗️ Architecture
<img width="1212" height="642" alt="Architecture" 
src="https://github.com/user-attachments/assets/d2aacfe7-85fd-447f-aaab-73a3995960b4" />

## 🛠️ Tech Stack
- **App:** TypeScript / Node.js / Express / Prisma / PostgreSQL
- **Containerization:** Docker, AWS ECR
- **CI/CD:** GitHub Actions (OIDC auth, no static credentials)
- **Infrastructure:** Terraform (VPC, EKS, IAM)
- **Orchestration:** Kubernetes (EKS), Helm
- **Monitoring:** Prometheus, Grafana

## 📋 Features
- [x] Fiber connection documentation and topology visualization
- [x] Node management (RADIO, SWITCH, SERVER) with rack location tracking
- [x] Connection status management (ACTIVE/INACTIVE/MAINTENANCE)
- [x] Automated CI/CD pipeline — push to main triggers full deployment
- [x] Infrastructure as Code — entire AWS stack provisioned with Terraform
- [x] Monitoring with Prometheus and Grafana
- [ ] Optical switch management via REST API (Calient integration)

## 🚀 Deployment
Every push to `main` triggers the GitHub Actions pipeline:
1. Docker image is built and pushed to AWS ECR (tagged with git SHA)
2. Helm deploys the new image to EKS automatically

**Live demo:** [http://k8s-default-fiveglab-7ae744534c-677798005.eu-north-1.elb.amazonaws.com](http://k8s-default-fiveglab-7ae744534c-677798005.eu-north-1.elb.amazonaws.com)

## 📐 Architecture Decisions
**AWS EKS** — managed Kubernetes that handles control plane availability, 
allowing focus on application deployment rather than cluster maintenance.

**Helm** — templated Kubernetes manifests with environment-specific values, 
enabling repeatable deployments across environments with a single command.

**GitHub Actions** — native CI/CD integration with the repository, 
eliminating the need for a separate CI server (Jenkins).

**Terraform** — entire AWS infrastructure (VPC, subnets, EKS, IAM roles) 
defined as code, reproducible with `terraform apply` and cleanly 
destroyable with `terraform destroy`.

## 🔧 Local Development
```bash
# Start PostgreSQL
docker compose up -d

# Install dependencies and run migrations
npm install
npm run prisma:migrate

# Start development server
npm run dev
```

App available at `http://localhost:3000`

## 📊 Monitoring
Prometheus scrapes metrics from the cluster and application.
Grafana dashboards visualize cluster health, pod status and resource usage.

## 🔐 Security
- **OIDC authentication** — GitHub Actions assumes AWS IAM role via 
  short-lived tokens instead of static access keys. Credentials exist 
  only for the duration of the pipeline run.
- **Kubernetes Secrets** — database credentials stored as K8s secrets, 
  never in environment variables or repository.
- **Private subnets** — application pods run in private subnets, 
  only accessible through the AWS Load Balancer.
