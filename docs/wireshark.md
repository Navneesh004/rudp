# Capturing RUDP with Wireshark

## 1. Capture a trace in the benchmark containers

```bash
KEEP=1 LOSSES="5" RUNS=1 bash bench/run.sh        # leaves containers running with 5% loss
docker compose exec -d sender tcpdump -i eth0 -w /tmp/trace.pcap udp port 9000
docker compose exec -d receiver sh -c "node dist/src/cli/recv.js 9000 /tmp/out.bin"
docker compose exec sender node dist/src/cli/send.js receiver 9000 /tmp/test.bin
docker compose exec sender pkill tcpdump
docker compose cp sender:/tmp/trace.pcap ./trace.pcap
docker compose down
```

Or capture locally: run `npm run recv -- 9000 out.bin` and `npm run send -- 127.0.0.1 9000 test.bin`
while Wireshark listens on the loopback adapter with the filter `udp port 9000`.

`*.pcap` files are in `.gitignore`; only the screenshots go into the repository.

## 2. Decode the RUDP header

Copy [`rudp.lua`](rudp.lua) into Wireshark's personal Lua plugins folder
(*Help → About Wireshark → Folders → Personal Lua Plugins*) and reload with
<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd>. Packets on UDP port 9000 now show
as `RUDP` with their flags, sequence and ACK numbers, window and SACK blocks in
the Info column.

Useful display filters:

| Filter | Shows |
| --- | --- |
| `rudp.flags.syn == 1 \|\| rudp.flags.fin == 1` | handshake and teardown |
| `rudp.flags.sack == 1` | ACKs that carry SACK blocks (out-of-order data at the receiver) |
| `rudp.length > 0` | data segments only |

To find a retransmission, look for the same `rudp.seq` appearing twice among data
segments (*Statistics → Conversations* or sort by the Sequence number column).

## 3. Screenshots for the README

Save these two to `docs/`:

- `docs/handshake.png`: the SYN → SYN+ACK → ACK exchange, with `Mode=selective repeat` visible on the SYN.
- `docs/retransmission.png`: a lost segment, the duplicate ACKs carrying SACK blocks, and the retransmitted segment.
