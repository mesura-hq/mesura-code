# Host stats fixtures

Each directory is a `procRoot`/`sysRoot` pair (`<host>/proc`, `<host>/sys`) for `HostStatsCollector.make`. The files are real reads from three hosts on 2026-09-28, cut down to what the readers open. `/sys` symlinks (`class/net/<if>/device`, `class/drm/cardN/device`, `class/hwmon/hwmonN`) are plain directories here; the readers only test that the path exists.

- `vigilia-home/`: AMD Ryzen desktop, 16 CPUs, AMD Phoenix1 iGPU (`0x1002`) as `card0`, `k10temp` beside `nvme`, `amdgpu` and `nct6687` sensors. Physical NICs `enp5s0` and `wlp12s0`; `lo`, `tailscale0`, `docker0`, one bridge and two veths have no `device`.
- `vigilia-home-60s-later/`: `proc/stat` and `proc/net/dev` from the same host, read 60.01 s after `vigilia-home/`. Tests overlay these on a copy of `vigilia-home/` for the second reading.
- `arch-laptop/`: NVIDIA `0x10de` as `card0` (PCI `0000:64:00.0`, the address `nvidia-smi` reports as `00000000:64:00.0`) and AMD `0x1002` as `card1`, battery `BAT1`, NICs `eno1` and `wlan0`. The `uevent` files keep only `DRIVER` and `PCI_SLOT_NAME`.
- `conversa/`: a 2-CPU VM. QEMU display adapter (`0x1234`) with no GPU metric files, no `/sys/class/hwmon` entries, NIC `enp1s0`.

Deliberate edits to the captured values:

- `arch-laptop/sys/class/drm/card0/device/power/runtime_status` is `suspended`. The GPU was `active` at capture time; `suspended` is the value it reads when runtime PM powers it down, which is the case the collector must not wake.
- `conversa/proc/meminfo` has `SwapTotal`, `SwapFree` and `SwapCached` set to `0`, the values a Linux host without swap reports. conversa had 8 GiB of swap at capture time; the fixture keeps the no-swap case the plan names.
