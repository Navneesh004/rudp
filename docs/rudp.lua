-- Wireshark dissector for RUDP (see src/packet.ts for the wire format).
--
-- Install: copy this file to your Wireshark personal Lua plugins folder
-- (Help > About Wireshark > Folders > "Personal Lua Plugins"), then restart
-- Wireshark or press Ctrl+Shift+L. Traffic on UDP port 9000 is decoded as RUDP;
-- for other ports use Analyze > Decode As... > RUDP.

local rudp = Proto("rudp", "Reliable UDP (RUDP)")

local FLAG_SYN, FLAG_ACK, FLAG_FIN, FLAG_SACK = 1, 2, 4, 8
local MODES = { [0] = "stop-and-wait", [1] = "Go-Back-N", [2] = "selective repeat" }

local f = rudp.fields
f.seq      = ProtoField.uint32("rudp.seq", "Sequence number", base.DEC)
f.ack      = ProtoField.uint32("rudp.ack", "Acknowledgment number", base.DEC)
f.flags    = ProtoField.uint8("rudp.flags", "Flags", base.HEX)
f.syn      = ProtoField.bool("rudp.flags.syn", "SYN", 8, nil, FLAG_SYN)
f.ackf     = ProtoField.bool("rudp.flags.ack", "ACK", 8, nil, FLAG_ACK)
f.fin      = ProtoField.bool("rudp.flags.fin", "FIN", 8, nil, FLAG_FIN)
f.sack     = ProtoField.bool("rudp.flags.sack", "SACK", 8, nil, FLAG_SACK)
f.window   = ProtoField.uint16("rudp.window", "Window (segments)", base.DEC)
f.length   = ProtoField.uint16("rudp.length", "Payload length", base.DEC)
f.checksum = ProtoField.uint32("rudp.checksum", "Checksum (CRC32)", base.HEX)
f.version  = ProtoField.uint8("rudp.version", "Protocol version", base.DEC)
f.mode     = ProtoField.uint8("rudp.mode", "Reliability mode", base.DEC, MODES)
f.sack_l   = ProtoField.uint32("rudp.sack.left", "SACK left edge", base.DEC)
f.sack_r   = ProtoField.uint32("rudp.sack.right", "SACK right edge", base.DEC)
f.data     = ProtoField.bytes("rudp.data", "Data")

local function has(flags, bit)
  return math.floor(flags / bit) % 2 == 1
end

function rudp.dissector(buf, pinfo, tree)
  if buf:len() < 17 then return 0 end
  pinfo.cols.protocol = "RUDP"

  local seq, ack = buf(0, 4):uint(), buf(4, 4):uint()
  local flags = buf(8, 1):uint()
  local window, len = buf(9, 2):uint(), buf(11, 2):uint()

  local t = tree:add(rudp, buf(), "Reliable UDP")
  t:add(f.seq, buf(0, 4))
  t:add(f.ack, buf(4, 4))
  local ft = t:add(f.flags, buf(8, 1))
  ft:add(f.syn, buf(8, 1)); ft:add(f.ackf, buf(8, 1)); ft:add(f.fin, buf(8, 1)); ft:add(f.sack, buf(8, 1))
  t:add(f.window, buf(9, 2))
  t:add(f.length, buf(11, 2))
  t:add(f.checksum, buf(13, 4))

  local names = {}
  if has(flags, FLAG_SYN) then names[#names + 1] = "SYN" end
  if has(flags, FLAG_ACK) then names[#names + 1] = "ACK" end
  if has(flags, FLAG_FIN) then names[#names + 1] = "FIN" end
  if has(flags, FLAG_SACK) then names[#names + 1] = "SACK" end
  local info = string.format("[%s] Seq=%u Ack=%u Win=%u Len=%u", table.concat(names, ", "), seq, ack, window, len)

  if len > 0 and buf:len() >= 17 + len then
    local payload = buf(17, len)
    if has(flags, FLAG_SYN) and len >= 2 then
      t:add(f.version, payload(0, 1))
      t:add(f.mode, payload(1, 1))
      info = info .. " Mode=" .. (MODES[payload(1, 1):uint()] or "?")
    elseif has(flags, FLAG_SACK) then
      local edges = {}
      for off = 0, len - 8, 8 do
        local l, r = payload(off, 4):uint(), payload(off + 4, 4):uint()
        local bt = t:add(rudp, payload(off, 8), string.format("SACK block %u-%u", l, r))
        bt:add(f.sack_l, payload(off, 4))
        bt:add(f.sack_r, payload(off + 4, 4))
        edges[#edges + 1] = string.format("%u-%u", l, r)
      end
      info = info .. " SACK=" .. table.concat(edges, ",")
    else
      t:add(f.data, payload)
    end
  end

  pinfo.cols.info = info
  return buf:len()
end

DissectorTable.get("udp.port"):add(9000, rudp)
