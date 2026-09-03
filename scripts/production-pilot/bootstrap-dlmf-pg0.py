from __future__ import annotations

import os
import secrets
import socket
from pathlib import Path
from urllib.parse import quote, unquote, urlparse

from pg0 import Pg0


DEFAULT_PORT = 55432
MAX_PORT_ATTEMPTS = 32
DEFAULT_INSTANCE_PREFIX = "dlmf-pilot-v011"
DEFAULT_USERNAME = "dlmf_pilot"
DEFAULT_DATABASE = "dlmf_pilot"


def _parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :]
        key, sep, value = line.partition("=")
        if not sep:
            continue
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        values[key] = value
    return values


def _credentials_from_url(url: str) -> tuple[str, str, str, int]:
    parsed = urlparse(url)
    if parsed.scheme not in {"postgres", "postgresql"}:
        raise RuntimeError("Existing DLMF pilot database URL is not PostgreSQL")
    if parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise RuntimeError("DLMF pg0 bootstrap refuses a non-local existing database URL")
    username = unquote(parsed.username or "")
    password = unquote(parsed.password or "")
    database = unquote((parsed.path or "").lstrip("/"))
    port = parsed.port or DEFAULT_PORT
    if not username or not password or not database:
        raise RuntimeError("Existing DLMF pilot database URL is missing local pg0 credentials/database")
    return username, password, database, port


def _database_url(username: str, password: str, database: str, port: int) -> str:
    return (
        f"postgresql://{quote(username, safe='')}:{quote(password, safe='')}"
        f"@127.0.0.1:{port}/{quote(database, safe='')}"
    )


def _port_available(port: int) -> bool:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
        sock.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        sock.close()


def _next_available_port(start_port: int) -> int:
    for port in range(start_port, start_port + MAX_PORT_ATTEMPTS):
        if _port_available(port):
            return port
    raise RuntimeError(
        f"No free localhost port found in range {start_port}-{start_port + MAX_PORT_ATTEMPTS - 1}"
    )


def _write_private_config(
    path: Path,
    *,
    instance_name: str,
    username: str,
    password: str,
    database: str,
    port: int,
) -> None:
    database_url = _database_url(username, password, database, port)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        path.parent.chmod(0o700)
    except OSError:
        pass
    path.write_text(
        "# DLMF v0.1.1 production pilot — local embedded PostgreSQL\n"
        f"DLMF_PILOT_PG0_NAME='{instance_name}'\n"
        f"DLMF_PILOT_PG_PORT='{port}'\n"
        f"DLMF_PILOT_DATABASE_URL='{database_url}'\n",
        encoding="utf-8",
    )
    path.chmod(0o600)


def _pg0_info(pg: Pg0):
    try:
        return pg.info()
    except Exception:
        return None


def main() -> None:
    home = Path(os.environ.get("HOME") or Path.home())
    config_path = Path(
        os.environ.get(
            "DLMF_PILOT_ENV_FILE",
            str(home / ".config" / "dlmf" / "production-pilot.env"),
        )
    ).expanduser().resolve()
    existing = _parse_env_file(config_path)
    existing_url = existing.get("DLMF_PILOT_DATABASE_URL")

    if existing_url:
        username, password, database, configured_port = _credentials_from_url(existing_url)
        instance_name = (
            existing.get("DLMF_PILOT_PG0_NAME")
            or os.environ.get("DLMF_PILOT_PG0_NAME")
            or f"{DEFAULT_INSTANCE_PREFIX}-{configured_port}"
        )
        requested_port = int(
            os.environ.get(
                "DLMF_PILOT_PG_PORT",
                existing.get("DLMF_PILOT_PG_PORT", str(configured_port)),
            )
        )
        new_configuration = False
    else:
        username = DEFAULT_USERNAME
        database = DEFAULT_DATABASE
        password = secrets.token_urlsafe(32)
        requested_port = int(os.environ.get("DLMF_PILOT_PG_PORT", str(DEFAULT_PORT)))
        # The failed v0 bootstrap used the unsuffixed name. A port-specific name
        # intentionally avoids inheriting a partially initialized cluster whose
        # random password may have been lost before the config file was written.
        instance_name = os.environ.get("DLMF_PILOT_PG0_NAME") or ""
        new_configuration = True

    selected_port = requested_port
    if new_configuration:
        selected_port = _next_available_port(requested_port)
        if not instance_name:
            instance_name = f"{DEFAULT_INSTANCE_PREFIX}-{selected_port}"
    elif not _port_available(selected_port):
        # It may already be our own running pg0. Check that before moving ports.
        probe = Pg0(
            name=instance_name,
            username=username,
            password=password,
            database=database,
            port=selected_port,
            config={"listen_addresses": "127.0.0.1"},
        )
        info = _pg0_info(probe)
        if info is not None and getattr(info, "running", False):
            actual_port = urlparse(str(info.uri)).port or selected_port
            _write_private_config(
                config_path,
                instance_name=instance_name,
                username=username,
                password=password,
                database=database,
                port=actual_port,
            )
            print("DLMF Pilot PostgreSQL bootstrap")
            print(f"instance={instance_name}")
            print(f"target=127.0.0.1:{actual_port}/{database}")
            print(f"config={config_path}")
            print("credentials=stored_private_not_printed")
            print("state=already_running")
            print("DLMF_PILOT_PG0_BOOTSTRAP=PASS")
            return
        selected_port = _next_available_port(selected_port + 1)

    # Persist credentials BEFORE starting PostgreSQL. If startup fails for any
    # reason, the next bootstrap run reuses the same credentials and instance.
    _write_private_config(
        config_path,
        instance_name=instance_name,
        username=username,
        password=password,
        database=database,
        port=selected_port,
    )

    last_error: Exception | None = None
    for attempt in range(MAX_PORT_ATTEMPTS):
        port = selected_port + attempt
        if attempt > 0 and not _port_available(port):
            continue
        if port != selected_port:
            _write_private_config(
                config_path,
                instance_name=instance_name,
                username=username,
                password=password,
                database=database,
                port=port,
            )

        pg = Pg0(
            name=instance_name,
            username=username,
            password=password,
            database=database,
            port=port,
            config={"listen_addresses": "127.0.0.1"},
        )
        info = _pg0_info(pg)
        if info is not None and getattr(info, "running", False):
            actual_port = urlparse(str(info.uri)).port or port
            _write_private_config(
                config_path,
                instance_name=instance_name,
                username=username,
                password=password,
                database=database,
                port=actual_port,
            )
            break

        try:
            info = pg.start()
            actual_port = urlparse(str(info.uri)).port or port
            _write_private_config(
                config_path,
                instance_name=instance_name,
                username=username,
                password=password,
                database=database,
                port=actual_port,
            )
            break
        except Exception as exc:
            last_error = exc
            # Port contention can race the pre-bind check. Move to the next
            # localhost port while preserving instance identity and credentials.
            if "address already in use" in str(exc).lower() or "already running" in exc.__class__.__name__.lower():
                continue
            raise
    else:
        raise RuntimeError(
            f"Failed to start DLMF pilot PostgreSQL after {MAX_PORT_ATTEMPTS} local port attempts: {last_error}"
        )

    actual_uri = str(info.uri)
    parsed_actual = urlparse(actual_uri)
    if parsed_actual.hostname not in {"127.0.0.1", "localhost", "::1"}:
        try:
            pg.stop()
        finally:
            raise RuntimeError("Embedded DLMF PostgreSQL did not resolve to a local endpoint")

    actual_port = parsed_actual.port or port
    _write_private_config(
        config_path,
        instance_name=instance_name,
        username=username,
        password=password,
        database=database,
        port=actual_port,
    )

    print("DLMF Pilot PostgreSQL bootstrap")
    print(f"instance={instance_name}")
    print(f"target=127.0.0.1:{actual_port}/{database}")
    print(f"config={config_path}")
    print("credentials=stored_private_not_printed")
    print("state=started")
    print("DLMF_PILOT_PG0_BOOTSTRAP=PASS")


if __name__ == "__main__":
    main()
