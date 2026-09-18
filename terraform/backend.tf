terraform {
  backend "s3" {
    bucket = "5g-lab-terraform-state-mh"
    key    = "eks/terraform.tfstate"
    region = "eu-north-1"
    use_lockfile = true
  }
}

