"""Print the NotionTool MCP bearer token, decrypting the DPAPI session file.

Usage:  python tools\\notiontool-token.py [--data-dir <path>]

NotionTool writes the token to <data-dir>\\sessions\\session_host_api.bin as a
DPAPI-protected blob (only readable by the current Windows user). This script
decrypts it and prints the JSON it contains, so the token can be copied into
%USERPROFILE%\\.dsh\\.env as NOTIONTOOL_MCP_TOKEN=<token>.

It prints the token only; it never writes to disk.
"""
import argparse
import ctypes
import json
import os
import sys
from ctypes import wintypes


class DATA_BLOB(ctypes.Structure):
    _fields_ = [
        ("cbData", wintypes.DWORD),
        ("pbData", ctypes.POINTER(ctypes.c_char)),
    ]


def decrypt(raw: bytes) -> bytes:
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32

    buf_in = ctypes.create_string_buffer(raw, len(raw))
    blob_in = DATA_BLOB(len(raw), ctypes.cast(buf_in, ctypes.POINTER(ctypes.c_char)))
    blob_out = DATA_BLOB()

    ok = crypt32.CryptUnprotectData(
        ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out)
    )
    if not ok:
        raise OSError(ctypes.get_last_error(), "CryptUnprotectData failed")

    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        kernel32.LocalFree(blob_out.pbData)


def default_data_dir() -> str:
    # The NotionTool launcher is started with --data-dir pointing at one of these.
    candidates = [
        os.path.join(os.path.expanduser("~"), "Downloads", "NotionTool-harness", "NotionTool", "data"),
        os.path.join(os.path.expanduser("~"), "Documents", "NotionTool", "data"),
    ]
    for path in candidates:
        if os.path.exists(os.path.join(path, "sessions", "session_host_api.bin")):
            return path
    return candidates[0]


def main() -> int:
    parser = argparse.ArgumentParser(description="Print the NotionTool MCP bearer token.")
    parser.add_argument("--data-dir", default=None, help="NotionTool data directory")
    parser.add_argument("--token-only", action="store_true", help="print just the token")
    args = parser.parse_args()

    data_dir = args.data_dir or default_data_dir()
    blob_path = os.path.join(data_dir, "sessions", "session_host_api.bin")
    if not os.path.exists(blob_path):
        print("not found: " + blob_path, file=sys.stderr)
        print("pass --data-dir <NotionTool data directory>", file=sys.stderr)
        return 1

    with open(blob_path, "rb") as handle:
        raw = handle.read()

    try:
        payload = json.loads(decrypt(raw).decode("utf-8"))
    except (OSError, ValueError) as exc:
        print("could not decrypt " + blob_path + ": " + str(exc), file=sys.stderr)
        print("NotionTool must have written it under your own Windows account.", file=sys.stderr)
        return 1

    token = payload.get("key")
    if not token:
        print("no 'key' field in the decrypted payload", file=sys.stderr)
        return 1

    if args.token_only:
        print(token)
    else:
        print("token: " + token)
        print('add to %USERPROFILE%\\.dsh\\.env  ->  NOTIONTOOL_MCP_TOKEN=' + token)
    return 0


if __name__ == "__main__":
    sys.exit(main())
