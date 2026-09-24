import socket

def encode_length(n):
    if n < 128: return bytes([n])
    elif n < 256: return bytes([0x81, n])
    else: return bytes([0x82, (n>>8)&0xff, n&0xff])

def tlv(tag, value):
    return bytes([tag]) + encode_length(len(value)) + value

def encode_oid(oid_str):
    parts = list(map(int, oid_str.split('.')))
    enc = bytes([40*parts[0]+parts[1]])
    for p in parts[2:]:
        if p == 0:
            enc += bytes([0])
        else:
            b = []
            while p:
                b.append(p & 0x7f)
                p >>= 7
            b.reverse()
            enc += bytes([x|0x80 for x in b[:-1]] + [b[-1]])
    return enc

def build_get(community, oid_str):
    oid_enc = encode_oid(oid_str)
    oid_tlv = tlv(0x06, oid_enc)
    null = bytes([0x05, 0x00])
    varbind = tlv(0x30, oid_tlv + null)
    vblist = tlv(0x30, varbind)
    pdu_inner = bytes([0x02,0x01,0x01, 0x02,0x01,0x00, 0x02,0x01,0x00]) + vblist
    req_pdu = tlv(0xa0, pdu_inner)
    return tlv(0x30, bytes([0x02,0x01,0x00]) + tlv(0x04, community.encode()) + req_pdu)

def parse_tlv(data, offset=0):
    if offset >= len(data):
        return None, b'', offset
    tag = data[offset]
    offset += 1
    if offset >= len(data):
        return tag, b'', offset
    if data[offset] < 0x80:
        length = data[offset]
        offset += 1
    elif data[offset] == 0x81 and offset+1 < len(data):
        length = data[offset+1]
        offset += 2
    elif data[offset] == 0x82 and offset+2 < len(data):
        length = (data[offset+1]<<8)|data[offset+2]
        offset += 3
    else:
        return tag, b'', offset+1
    value = data[offset:offset+length]
    return tag, value, offset+length

def find_varbind_value(data):
    tag, outer, _ = parse_tlv(data, 0)
    if tag != 0x30:
        return None
    inner_offset = 0
    _, _, inner_offset = parse_tlv(outer, inner_offset)  # version
    _, cval, inner_offset = parse_tlv(outer, inner_offset)  # community
    ptag, pval, _ = parse_tlv(outer, inner_offset)  # PDU
    if ptag not in (0xa0, 0xa2):
        return None
    pi = 0
    _, _, pi = parse_tlv(pval, pi)  # reqid
    etag, eval_, pi = parse_tlv(pval, pi)  # errStatus
    if etag == 0x02 and eval_ and eval_[0] != 0:
        return 'SNMP-ERROR:{}'.format(eval_[0])
    _, _, pi = parse_tlv(pval, pi)  # errIdx
    lstag, lstval, pi = parse_tlv(pval, pi)  # varbindList
    vbi = 0
    _, vbval, _ = parse_tlv(lstval, vbi)  # first varbind
    vbi2 = 0
    _, oidval, vbi2 = parse_tlv(vbval, vbi2)  # OID
    vtag, vval, _ = parse_tlv(vbval, vbi2)  # actual value
    if vtag == 0x04:
        return vval.decode('latin-1')
    elif vtag == 0x02 and vval:
        return int.from_bytes(vval, 'big', signed=True)
    elif vtag in (0x41, 0x42, 0x43) and vval:
        return int.from_bytes(vval, 'big')
    elif vtag == 0x05:
        return '<null>'
    else:
        return 'tag:{:02x}:{}'.format(vtag, vval.hex())

def snmp_get(host, community, oid_str, timeout=3):
    pkt = build_get(community, oid_str)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(timeout)
    try:
        s.sendto(pkt, (host, 161))
        data, _ = s.recvfrom(4096)
        return find_varbind_value(data)
    except socket.timeout:
        return 'TIMEOUT'
    except Exception as e:
        return 'ERR:{}'.format(e)
    finally:
        s.close()

OIDS = [
    ('sysDescr',          '1.3.6.1.2.1.1.1.0'),
    ('sysName',           '1.3.6.1.2.1.1.5.0'),
    ('sysLocation',       '1.3.6.1.2.1.1.6.0'),
    ('sysContact',        '1.3.6.1.2.1.1.4.0'),
    ('sysUpTime',         '1.3.6.1.2.1.1.3.0'),
    ('upsModel',          '1.3.6.1.4.1.318.1.1.1.1.1.1.0'),
    ('upsFirmware',       '1.3.6.1.4.1.318.1.1.1.1.1.2.0'),
    ('upsSerial',         '1.3.6.1.4.1.318.1.1.1.1.1.3.0'),
    ('upsMfrDate',        '1.3.6.1.4.1.318.1.1.1.1.1.4.0'),
    ('upsName',           '1.3.6.1.4.1.318.1.1.1.1.1.5.0'),
    ('battStatus',        '1.3.6.1.4.1.318.1.1.1.2.1.1.0'),
    ('battCapPct',        '1.3.6.1.4.1.318.1.1.1.2.2.1.0'),
    ('battTemp_C',        '1.3.6.1.4.1.318.1.1.1.2.2.2.0'),
    ('battRuntime_min',   '1.3.6.1.4.1.318.1.1.1.2.2.3.0'),
    ('battVolt',          '1.3.6.1.4.1.318.1.1.1.2.2.8.0'),
    ('battReplDate',      '1.3.6.1.4.1.318.1.1.1.2.2.21.0'),
    ('battNomVolt',       '1.3.6.1.4.1.318.1.1.1.2.2.9.0'),
    ('inputVolt_V',       '1.3.6.1.4.1.318.1.1.1.3.2.1.0'),
    ('inputMaxVolt',      '1.3.6.1.4.1.318.1.1.1.3.2.2.0'),
    ('inputMinVolt',      '1.3.6.1.4.1.318.1.1.1.3.2.3.0'),
    ('inputFreq_Hz',      '1.3.6.1.4.1.318.1.1.1.3.2.4.0'),
    ('inputXferReason',   '1.3.6.1.4.1.318.1.1.1.3.2.5.0'),
    ('inputLineVolt',     '1.3.6.1.4.1.318.1.1.1.3.3.1.0'),
    ('outputVolt_V',      '1.3.6.1.4.1.318.1.1.1.4.2.1.0'),
    ('outputFreq_Hz',     '1.3.6.1.4.1.318.1.1.1.4.2.2.0'),
    ('outputLoadPct',     '1.3.6.1.4.1.318.1.1.1.4.2.3.0'),
    ('outputCurrent_A',   '1.3.6.1.4.1.318.1.1.1.4.2.4.0'),
    ('outputWatts',       '1.3.6.1.4.1.318.1.1.1.4.2.8.0'),
    ('outputVA',          '1.3.6.1.4.1.318.1.1.1.4.2.9.0'),
    ('outputStatus',      '1.3.6.1.4.1.318.1.1.1.4.1.1.0'),
    ('upsBasicStatus',    '1.3.6.1.4.1.318.1.1.1.11.1.1.0'),
    ('upsTestResult',     '1.3.6.1.4.1.318.1.1.1.7.2.3.0'),
    ('upsTestDate',       '1.3.6.1.4.1.318.1.1.1.7.2.5.0'),
    ('upsCapacity_VA',    '1.3.6.1.4.1.318.1.1.1.1.2.7.0'),
    ('nmcHwRev',          '1.3.6.1.4.1.318.1.1.12.4.1.1.0'),
    ('nmcFwRev',          '1.3.6.1.4.1.318.1.1.12.4.1.2.0'),
    ('nmcSerial',         '1.3.6.1.4.1.318.1.1.12.4.1.3.0'),
    ('nmcModel',          '1.3.6.1.4.1.318.1.1.12.4.1.4.0'),
    ('nmcProductName',    '1.3.6.1.4.1.318.1.1.12.1.1.0'),
]

# Full query on .224 with 'private' community
print("=== 192.168.0.224 SNMP v1 community=private ===")
for name, oid in OIDS:
    v = snmp_get('192.168.0.224', 'private', oid)
    print("  {}: {}".format(name, v))

# Full query on .226
print("\n=== 192.168.0.226 SNMP v1 community=public ===")
for name, oid in OIDS:
    v = snmp_get('192.168.0.226', 'public', oid)
    print("  {}: {}".format(name, v))
