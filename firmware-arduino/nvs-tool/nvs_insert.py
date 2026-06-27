#!/usr/bin/env python3
"""
Surgically insert wifi:ota_url=<URL> into an NVS partition dump.
Reads an existing NVS bin, finds the Active page, finds N consecutive empty
entries (N = 1 header + ceil(len(value)+1 / 32) value entries), writes the
header+data with proper CRCs, and flips the entry-state bitmap from empty
(0b11) to written (0b10) for each new entry. Leaves all other bytes intact.

Usage: nvs_insert_ota_url.py <in.bin> <out.bin> <namespace> <key> <value>
"""
import sys
from zlib import crc32

PAGE_SIZE = 4096
ENTRY_SIZE = 32

PAGE_STATUS_ACTIVE = 0xFFFFFFFE
PAGE_STATUS_FULL = 0xFFFFFFFC

ITEM_STRING = 0x21


def find_namespace_index(buf: bytes, namespace: str) -> int:
    """Walk the entries in namespace 000 (the namespace registry) to map a
    namespace name to its uint8_t index."""
    for page_start in range(0, len(buf), PAGE_SIZE):
        page = buf[page_start:page_start + PAGE_SIZE]
        if len(page) < PAGE_SIZE:
            continue
        status = int.from_bytes(page[0:4], "little")
        if status not in (PAGE_STATUS_ACTIVE, PAGE_STATUS_FULL):
            continue
        bitmap = page[ENTRY_SIZE:2 * ENTRY_SIZE]
        for i in range(126):
            state = (bitmap[i // 4] >> ((i % 4) * 2)) & 0b11
            if state != 0b10:  # only Written
                continue
            off = (i + 2) * ENTRY_SIZE
            entry = page[off:off + ENTRY_SIZE]
            ns = entry[0]
            etype = entry[1]
            if ns != 0 or etype != 0x01:  # uint8_t in NS 0
                continue
            key = entry[8:24].rstrip(b'\x00').decode("ascii", errors="replace")
            if key == namespace:
                return entry[24]  # value byte (uint8_t)
    raise SystemExit(f"namespace {namespace!r} not found in NVS")


def find_active_page(buf: bytes) -> int:
    for page_start in range(0, len(buf), PAGE_SIZE):
        status = int.from_bytes(buf[page_start:page_start + 4], "little")
        if status == PAGE_STATUS_ACTIVE:
            return page_start
    raise SystemExit("no Active page found")


def find_empty_run(page: bytes, length: int) -> int:
    """Return the entry index (0..125) where `length` consecutive Empty entries
    start, scanning forward."""
    bitmap = page[ENTRY_SIZE:2 * ENTRY_SIZE]
    states = []
    for i in range(126):
        states.append((bitmap[i // 4] >> ((i % 4) * 2)) & 0b11)
    run = 0
    start = -1
    for i, s in enumerate(states):
        if s == 0b11:
            if run == 0:
                start = i
            run += 1
            if run >= length:
                return start
        else:
            run = 0
            start = -1
    raise SystemExit(f"no run of {length} empty entries on active page")


def build_entries(namespace_idx: int, key: str, value: str, span: int) -> bytes:
    """Build the raw bytes for the (span) entries: 1 header + (span-1) data."""
    value_bytes = value.encode("ascii") + b"\x00"
    size = len(value_bytes)
    value_crc = crc32(value_bytes, 0xFFFFFFFF)
    key_bytes = key.encode("ascii")
    if len(key_bytes) > 15:
        raise SystemExit("key too long (max 15 bytes)")
    key_field = key_bytes + b"\x00" * (16 - len(key_bytes))

    # Header entry, CRC pending
    header = bytearray(ENTRY_SIZE)
    header[0] = namespace_idx
    header[1] = ITEM_STRING
    header[2] = span
    header[3] = 0xFF  # chunk_index, 0xFF for non-blob
    # bytes 4-7: CRC (filled below)
    header[8:24] = key_field
    header[24:26] = size.to_bytes(2, "little")
    header[26:28] = b"\xff\xff"  # reserved
    header[28:32] = value_crc.to_bytes(4, "little")
    # entry CRC: over raw[:4] + raw[8:32]
    entry_crc = crc32(bytes(header[:4]) + bytes(header[8:32]), 0xFFFFFFFF)
    header[4:8] = entry_crc.to_bytes(4, "little")

    # Data entries: pad value to (span-1)*32 bytes with 0xFF
    padded = value_bytes + b"\xff" * ((span - 1) * ENTRY_SIZE - size)
    assert len(padded) == (span - 1) * ENTRY_SIZE
    return bytes(header) + padded


def set_written(bitmap: bytearray, entry_idx: int) -> None:
    """Flip an entry's state from Empty (0b11) to Written (0b10) by clearing
    bit 2*entry_idx within the bitmap (the lower bit of its 2-bit slot)."""
    byte_idx = entry_idx // 4
    bit_in_byte = (entry_idx % 4) * 2
    bitmap[byte_idx] &= 0xFF ^ (1 << bit_in_byte)


def main():
    if len(sys.argv) != 6:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    in_path, out_path, ns_name, key, value = sys.argv[1:]

    with open(in_path, "rb") as f:
        buf = bytearray(f.read())
    if len(buf) % PAGE_SIZE != 0:
        raise SystemExit("input not aligned to page size")

    ns_idx = find_namespace_index(buf, ns_name)
    print(f"namespace {ns_name!r} -> index {ns_idx}", file=sys.stderr)

    value_len = len(value.encode("ascii")) + 1  # +1 for null terminator
    data_entries = (value_len + ENTRY_SIZE - 1) // ENTRY_SIZE
    span = 1 + data_entries
    print(f"value {value_len} bytes -> {data_entries} data entries, span={span}",
          file=sys.stderr)

    page_start = find_active_page(buf)
    print(f"active page at offset 0x{page_start:x}", file=sys.stderr)
    page = bytes(buf[page_start:page_start + PAGE_SIZE])

    start_entry = find_empty_run(page, span)
    print(f"writing at entry index {start_entry} (offset 0x{(start_entry+2)*ENTRY_SIZE:x} in page)",
          file=sys.stderr)

    payload = build_entries(ns_idx, key, value, span)
    write_off = page_start + (start_entry + 2) * ENTRY_SIZE
    buf[write_off:write_off + len(payload)] = payload

    bitmap = bytearray(buf[page_start + ENTRY_SIZE:page_start + 2 * ENTRY_SIZE])
    for i in range(span):
        set_written(bitmap, start_entry + i)
    buf[page_start + ENTRY_SIZE:page_start + 2 * ENTRY_SIZE] = bitmap

    with open(out_path, "wb") as f:
        f.write(buf)
    print(f"wrote {out_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
