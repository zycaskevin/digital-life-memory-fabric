from __future__ import annotations

import os
import secrets
from pathlib import Path
from urllib.parse import quote, unquote, urlparse

from pg0 import Pg0


def _read_existing_url(path: Path) -> str | None:
    if not path.exists():
        return None
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :]
        key, sep, value = line.partition("=")
        if sep and key.strip() == "DLMF_PILOT_DATABASE_URL":
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
                value = value[1:-1]
            return value
    return None


def _credentials_from_url(url: str) -> tuple[str, str, str, int]:
    parsed = urlparse(url)
    if parsed.scheme not in {"postgres", "postgresql"}:
        raise RuntimeError("Existing DLMF pilot database URL is not PostgreSQL")
    if parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise RuntimeError("DLMF pg0 bootstrap refuses a non-local existing database URL")
    username = unquote(parsed.username or "")
    password = unquote(parsed.password or "")
    database = (parsed.path or "").lstrip("/")
    port = parsed.port or 55432
    if not username or not password or not database:
        raise RuntimeError("Existing DLMF pilot database URL is missing local pg0 credentials/database")
    return username, password, database, port


def _database_url(username: str, password: str, database: str, port: int) -> str:
    return (
        f"postgresql://{quote(username, safe='')}:{quote(password, safe='')}"
        f"@127.0.0.1:{port}/{quote(database, safe='')}"
    )


def main() -> None:
    home = Path(os.environ.get("HOME") or Path.home())
    config_path = Path(
        os.environ.get(
            "DLMF_PILOT_ENV_FILE",
            str(home / ".config" / "dlmf" / "production-pilot.env"),
        )
    ).expanduser().resolve()
    instance_name = os.environ.get("DLMF_PILOT_PG0_NAME", "dlmf-pilot-v011")
    default_port = int(os.environ.get("DLMF_PILOT_PG_PORT", "55432"))

    existing_url = _read_existing_url(config_path)
    if existing_url:
        username, password, database, port = _credentials_from_url(existing_url)
    else:
        username = "dlmf_pilot"
        database = "dlmf_pilot"
        port = default_port
        password = secrets.token_urlsafe(32)

    pg = Pg0(
        name=instance_name,
        username=username,
        password=password,
        database=database,
        port=port,
        config={"listen_addresses": "127.0.0.1"},
    )

    try:
        info = pg.info()
    except Exception:
        info = None

    if info is None or not getattr(info, "running", False):
        info = pg.start()

    actual_uri = str(info.uri)
    parsed_actual = urlparse(actual_uri)
    if parsed_actual.hostname not in {"127.0.0.1", "localhost", "::1"}:
        # pg0 may render localhost differently, but it must never expose the
        # DLMF pilot database on a non-local hostname through this bootstrap.
        try:
            pg.stop()
        finally:
            raise RuntimeError("Embedded DLMF PostgreSQL did not resolve to a local endpoint")

    # Use our known credentials rather than echoing pg0's URI. This also keeps
    # the written configuration deterministic across bootstrap runs.
    database_url = _database_url(username, password, database, port)
    config_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        config_path.parent.chmod(0o700)
    except OSError:
        pass
    config_path.write_text(
        "# DLMF v0.1.1 production pilot — local embedded PostgreSQL\n"
        f"DLMF_PILOT_DATABASE_URL='{database_url}'\n",
        encoding="utf-8",
    )
    config_path.chmod(0o600)

    print("DLMF Pilot PostgreSQL bootstrap")
    print(f"instance={instance_name}")
    print(f"target=127.0.0.1:{port}/{database}")
    print(f"config={config_path}")
    print("credentials=stored_private_not_printed")
    print("DLMF_PILOT_PG0_BOOTSTRAP=PASS")


if __name__ == "__main__":
    main()
