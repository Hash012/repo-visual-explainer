#!/usr/bin/env python3
"""Dependency-free atlas schema, geometry, reference and source validation."""
import argparse
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import sys

ASSETS = Path(__file__).resolve().parents[1] / 'assets'
MAX_JSON = 8 * 1024 * 1024
MAX_SOURCE = 2 * 1024 * 1024
MAX_LINES = 200
MAX_EXCERPT = 64 * 1024
NODE_KINDS = ('data-structure', 'functional-block')
ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$')


def parse_json(text):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError(f'duplicate JSON key: {key}')
            result[key] = value
        return result
    return json.loads(text, object_pairs_hook=pairs, parse_constant=lambda x: (_ for _ in ()).throw(ValueError(f'non-finite JSON value: {x}')))


def load_json(path):
    with open(path, 'rb') as stream:
        raw = stream.read(MAX_JSON + 1)
    if len(raw) > MAX_JSON:
        raise ValueError('JSON exceeds 8 MiB limit')
    return parse_json(raw.decode('utf-8'))


def schema_errors(value, schema, at='$'):
    """Implement the JSON Schema vocabulary used by the bundled schemas."""
    errors = []
    if 'anyOf' in schema:
        if not any(not schema_errors(value, s, at) for s in schema['anyOf']):
            return [f'{at}: does not match any allowed schema']
        return []
    kind = schema.get('type')
    valid = {'object': isinstance(value, dict), 'array': isinstance(value, list),
             'string': isinstance(value, str), 'null': value is None,
             'integer': type(value) is int, 'number': type(value) is int or (type(value) is float and math.isfinite(value)),
             'boolean': type(value) is bool}
    if kind and not valid.get(kind, False):
        return [f'{at}: expected {kind} (numbers must be finite)']
    if 'enum' in schema and value not in schema['enum']:
        errors.append(f'{at}: expected one of {schema["enum"]}')
    if isinstance(value, dict):
        props = schema.get('properties', {})
        for key in schema.get('required', []):
            if key not in value:
                errors.append(f'{at}.{key}: required field missing')
        for key, item in value.items():
            if key in props:
                errors.extend(schema_errors(item, props[key], f'{at}.{key}'))
            elif schema.get('additionalProperties') is False:
                errors.append(f'{at}.{key}: unexpected field')
    elif isinstance(value, list):
        if len(value) < schema.get('minItems', 0):
            errors.append(f'{at}: too few items')
        for i, item in enumerate(value):
            errors.extend(schema_errors(item, schema.get('items', {}), f'{at}[{i}]'))
    elif type(value) in (int, float):
        if 'minimum' in schema and value < schema['minimum']:
            errors.append(f'{at}: must be >= {schema["minimum"]}')
        if 'exclusiveMinimum' in schema and value <= schema['exclusiveMinimum']:
            errors.append(f'{at}: must be > {schema["exclusiveMinimum"]}')
    return errors


def source_lines(repo, relative):
    """Read only regular UTF-8 files beneath repo, without following any symlink."""
    if not isinstance(relative, str) or not relative or '\\' in relative or '\x00' in relative:
        raise ValueError('invalid evidence path')
    parts = relative.split('/')
    if PurePosixPath(relative).is_absolute() or any(p in ('', '.', '..') for p in parts):
        raise ValueError('evidence path must be a canonical repository-relative path')
    for part in parts:
        lower = part.lower()
        if lower.startswith('.env') or lower.endswith('.env') or lower in {'.git', '.ssh', '.aws', '.codex', '.agents'} or lower in {'id_rsa', 'id_ed25519', 'auth.json', 'token.json', 'credentials', 'credentials.json', 'credentials.yaml', 'credentials.yml', 'secrets', 'secrets.json', 'secrets.yaml', 'secrets.yml', '.netrc', '.npmrc', '.pypirc', '.git-credentials'} or lower.endswith(('.pem', '.key', '.p12', '.pfx')):
            raise ValueError('credential or hidden configuration evidence is forbidden')
    descriptors = []
    try:
        descriptors.append(os.open(repo, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW))
        for part in parts[:-1]:
            descriptors.append(os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptors[-1]))
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptors[-1])
        descriptors.append(fd)
        import stat
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > MAX_SOURCE:
            raise ValueError('evidence must be a regular text file no larger than 2 MiB')
        with os.fdopen(os.dup(fd), 'rb') as stream:
            data = stream.read(MAX_SOURCE + 1)
        if len(data) > MAX_SOURCE or b'\x00' in data:
            raise ValueError('evidence file is too large or binary')
        return data.decode('utf-8').splitlines(keepends=True)
    except (OSError, UnicodeError) as exc:
        raise ValueError(f'evidence is unavailable or not safe UTF-8: {relative}') from exc
    finally:
        for fd in reversed(descriptors):
            os.close(fd)


def excerpt(repo, evidence):
    start, end = evidence['start'], evidence['end']
    if type(start) is not int or type(end) is not int or start < 1 or end < start or end - start + 1 > MAX_LINES:
        raise ValueError('evidence range must be 1–200 lines, with end >= start')
    lines = source_lines(repo, evidence['path'])
    if end > len(lines):
        raise ValueError(f'evidence range exceeds {len(lines)} lines: {evidence["path"]}')
    text = ''.join(lines[start - 1:end])
    if len(text.encode('utf-8')) > MAX_EXCERPT:
        raise ValueError('source excerpt exceeds 64 KiB')
    return text


def overlapping_nodes(view):
    """Yield every overlap; display warning limits must not limit validity checks."""
    for i, a in enumerate(view['nodes']):
        for b in view['nodes'][i + 1:]:
            if (max(a['x'], b['x']) < min(a['x'] + a['width'], b['x'] + b['width'])
                    and max(a['y'], b['y']) < min(a['y'] + a['height'], b['y'] + b['height'])):
                yield a['id'], b['id']


def validate_atlas(atlas, repo=None, allow_legacy_nodes=False):
    schema = load_json(ASSETS / 'atlas.schema.json')
    if allow_legacy_nodes:
        # Runtime may retain historical graphs; new authoring remains strict by default.
        schema['properties']['views']['items']['properties']['nodes']['items']['properties']['kind'].pop('enum')
    errors = schema_errors(atlas, schema)
    warnings = []
    if errors:
        return errors, warnings
    if len(atlas['views']) > 50:
        errors.append('atlas: maximum 50 views')
    view_ids, elements = set(), {}
    for vi, view in enumerate(atlas['views']):
        at = f'views[{vi}]({view["id"]})'
        if not ID.fullmatch(view['id']) or view['id'] in view_ids:
            errors.append(f'{at}: view ID must be unique and use letters/digits/_.:-')
        view_ids.add(view['id'])
        if view['width'] > 50000 or view['height'] > 50000:
            errors.append(f'{at}: canvas dimensions exceed 50000')
        if len(view['nodes']) + len(view['edges']) > 1000 or len(view['groups']) > 200:
            errors.append(f'{at}: too many elements')
        node_ids, all_ids, group_ids = set(), set(), set()
        for section in ('groups', 'nodes', 'edges'):
            for item in view[section]:
                item_at = f'{at}.{section}({item["id"]})'
                seen = group_ids if section == 'groups' else all_ids
                if not ID.fullmatch(item['id']) or item['id'] in seen:
                    errors.append(f'{item_at}: invalid or duplicate ID')
                seen.add(item['id'])
                if section == 'nodes':
                    node_ids.add(item['id'])
                    if item['kind'] not in NODE_KINDS:
                        warnings.append(f'{item_at}: legacy node kind {item["kind"]!r}; classify as data-structure or functional-block when editing or refreshing')
                if section != 'edges':
                    if item['x'] < 0 or item['y'] < 0 or item['x'] + item['width'] > view['width'] or item['y'] + item['height'] > view['height']:
                        errors.append(f'{item_at}: shape lies outside canvas')
                else:
                    for point in item['points']:
                        if not (0 <= point['x'] <= view['width'] and 0 <= point['y'] <= view['height']):
                            errors.append(f'{item_at}: routing point lies outside canvas')
                if section != 'groups':
                    if item['status'] == 'verified' and not item['evidence']:
                        errors.append(f'{item_at}: verified claims require source evidence; use inferred for conceptual framing')
                    for evidence in item['evidence']:
                        try:
                            if repo is not None:
                                excerpt(repo, evidence)
                            elif evidence['end'] < evidence['start'] or evidence['end'] - evidence['start'] >= MAX_LINES:
                                raise ValueError('invalid or oversized range')
                        except ValueError as exc:
                            errors.append(f'{item_at}.evidence: {exc}')
        for edge in view['edges']:
            if edge['source'] not in node_ids or edge['target'] not in node_ids:
                errors.append(f'{at}.edges({edge["id"]}): source/target must reference nodes in this view')
        elements[view['id']] = all_ids
        for source, target in overlapping_nodes(view):
            if len(warnings) >= 100:
                break
            warnings.append(f'{at}: nodes {source} and {target} overlap')
    for view in atlas['views']:
        for node in view['nodes']:
            for link in node['links']:
                if link['view'] not in elements or (link['element'] and link['element'] not in elements.get(link['view'], set())):
                    errors.append(f'view {view["id"]}, node {node["id"]}: unresolved cross-view link {link}')
    return errors, warnings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('atlas', type=Path)
    parser.add_argument('--repo', type=Path, help='validate every evidence file and line range')
    args = parser.parse_args()
    try:
        errors, warnings = validate_atlas(load_json(args.atlas), args.repo.resolve() if args.repo else None)
    except (OSError, ValueError, RecursionError) as exc:
        errors, warnings = [str(exc)], []
    for warning in warnings:
        print(f'WARNING: {warning}', file=sys.stderr)
    for error in errors:
        print(f'ERROR: {error}', file=sys.stderr)
    if not errors:
        print('Atlas valid' + (' (evidence not checked; supply --repo)' if args.repo is None else ''))
    return int(bool(errors))


if __name__ == '__main__':
    sys.exit(main())
