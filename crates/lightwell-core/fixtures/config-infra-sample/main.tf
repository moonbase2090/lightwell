resource "aws_vpc" "main" {}

resource "aws_instance" "app" {
  depends_on = [aws_vpc.main]
}

module "network" {
  source = "./modules/network"
}
