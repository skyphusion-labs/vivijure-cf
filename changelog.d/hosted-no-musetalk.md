### fix(hosted): MuseTalk is not a hosted door

`MODULE_LIPSYNC` is unbound on the flagship Worker. Talking films keep
native AV from our keyframes. The finish-lipsync worker stays in the tree
for OSS / homelab (`wrangler.toml.example` SATELLITE block).
