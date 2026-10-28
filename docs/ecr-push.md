# Copy of the pod images in the lab ECR

On main, the `image` workflow also copies the default and Go images, by digest and with the same `sha-<commit>` tag, to
`824843843469.dkr.ecr.eu-west-3.amazonaws.com/lab/paseo-agent-default` and `.../lab/paseo-agent-go`, so the lab's nodes pull
them in region instead of from ghcr.io.

- The copy runs only when the repository variable `LAB_ECR_PUSH_ROLE_ARN` is set (Settings, Secrets and variables, Actions,
  Variables) to the ARN of the role `lab-paseo-agent-image-push` (a Terraform output of the lab). Unset, the workflow behaves
  as before.
- The workflow assumes that role with GitHub OIDC (`id-token: write`, no stored key). The role trusts only this repository's
  `main` branch and can only push to the two `lab/paseo-agent-*` repositories.
- Tags in those repositories are immutable: a re-run of the same commit fails at the copy step and leaves the first image in place.
