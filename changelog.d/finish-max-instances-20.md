### infra(finish): raise FinishContainer max_instances from 3 to 20

Three instances left two job slots, and a finished job holds its slot for the 10 minute idle tail. Six films were refused in five minutes on 2026-10-30. The worst case at 20 is about USD 8 per hour at full CPU, and nothing at rest. The cost basis is in docs/containers-control-plane.md. This applies on the next `v*` tag deploy.
