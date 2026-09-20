variable "aws_region" {
  type        = string
  description = "Region for aws" 
  default     = "eu-north-1"
}

variable "cluster_name" {
  type        = string
  description = "Cluster name"
  default     = "5g-lab-cluster"
}

variable "cluster_version" {
  type        = string
  description = "Cluster version"
  default     = "1.31"
}

