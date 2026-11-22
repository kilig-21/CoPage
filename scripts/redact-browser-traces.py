"""Remove fixture secrets from Playwright traces before uploading CI artifacts."""

import re
import sys
from pathlib import Path
from zipfile import ZipFile


PASSWORD = re.compile(rb"CopageFixture-[0-9a-f]{40}-Aa9!")
JWT = re.compile(rb"eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}")


def redact(trace: Path) -> None:
    temporary = trace.with_name("trace.redacted.zip")
    try:
        with ZipFile(trace) as source, ZipFile(temporary, "x") as target:
            for entry in source.infolist():
                data = source.read(entry)
                if PASSWORD.search(data) or JWT.search(data):
                    # The known patterns occur in trace JSON and response bodies.
                    # Preserve binary resources, and refuse uploads if a secret appears in one.
                    data.decode("utf-8")
                    data = JWT.sub(b"[redacted-jwt]", PASSWORD.sub(b"[redacted-password]", data))
                target.writestr(entry, data)
        temporary.replace(trace)
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    root = Path(sys.argv[1])
    for path in root.rglob("trace.zip"):
        if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
            raise ValueError("Trace path lies outside the Playwright artifact directory")
        redact(path)
