"""Pure diff, edit-authority and safe cited-file snapshot helpers."""
import hashlib
import json
from datetime import datetime, timezone

from validate_atlas import excerpt, source_lines

COVERAGE = ('Freshness covers only files explicitly cited by each view, using full-file SHA-256; '
            'it does not scan the repository or track uncited dependencies, Git state, or all AI reads. '
            'Unknown baselines require an explicit refresh. Source tokens detect cited-file changes '
            'between snapshots, not a filesystem transaction or transient change-and-revert.')
NODE_GEOMETRY = {'x', 'y', 'width', 'height'}


def now():
    return datetime.now(timezone.utc).isoformat()


def paths(view):
    return {e['path'] for item in view['nodes'] + view['edges'] for e in item['evidence']}


def snapshot(repo, cited):
    result = {}
    for path in sorted(cited):
        try:
            raw = ''.join(source_lines(repo, path)).encode('utf-8')
            result[path] = {'sha256': hashlib.sha256(raw).hexdigest()}
        except ValueError as exc:
            result[path] = {'error': str(exc)}
    return result


def token(files):
    return hashlib.sha256(json.dumps(files, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def freshness(atlas, baselines, files, checked_at):
    result = {}
    for view in atlas['views']:
        baseline = baselines.get(view['id'])
        unavailable = sorted(p for p in paths(view) if 'error' in files[p])
        changed = sorted(p for p in paths(view) if baseline and p in baseline['files']
                         and baseline['files'][p] is not None and files[p].get('sha256') != baseline['files'][p])
        unknown = baseline is None or any(baseline['files'].get(p) is None for p in paths(view))
        status = 'unavailable' if unavailable else 'stale' if changed else 'unknown' if unknown else 'fresh'
        result[view['id']] = {'status': status, 'changed_paths': changed,
                              'unavailable_paths': unavailable, 'checked_at': checked_at}
    return result


def canonical(atlas):
    """Identity-keyed sections ignore serialization order, including int/float equivalence."""
    result = {k: v for k, v in atlas.items() if k not in ('views', 'revision')}
    result['views'] = {}
    for view in atlas['views']:
        item = dict(view)
        for section in ('nodes', 'edges', 'groups'):
            item[section] = {e['id']: e for e in view[section]}
        result['views'][view['id']] = item
    return result


def diff(before, after):
    changes = []
    old, new = {v['id']: v for v in before['views']}, {v['id']: v for v in after['views']}
    for vid in sorted(old.keys() | new.keys()):
        if vid not in old or vid not in new:
            changes.append({'view': vid, 'kind': 'view', 'id': vid, 'fields': [],
                            'change': 'added' if vid in new else 'removed'})
            continue
        fields = sorted(k for k in old[vid] if k not in ('nodes', 'edges', 'groups') and old[vid][k] != new[vid][k])
        if fields:
            changes.append({'view': vid, 'kind': 'view', 'id': vid, 'fields': fields, 'change': 'changed'})
        for section, kind in (('nodes', 'node'), ('edges', 'edge'), ('groups', 'group')):
            a, b = {e['id']: e for e in old[vid][section]}, {e['id']: e for e in new[vid][section]}
            for eid in sorted(a.keys() | b.keys()):
                fields = sorted(k for k in a[eid] if a[eid][k] != b[eid][k]) if eid in a and eid in b else []
                if eid not in a or eid not in b or fields:
                    changes.append({'view': vid, 'kind': kind, 'id': eid, 'fields': fields,
                                    'change': 'added' if eid not in a else 'removed' if eid not in b else 'changed'})
    return changes


def neighbors(view, selected):
    node_ids = {n['id'] for n in view['nodes']}
    selected_nodes = set(selected) & node_ids
    result = set()
    for edge in view['edges']:
        if edge['id'] in selected or edge['source'] in selected_nodes or edge['target'] in selected_nodes:
            result.update((edge['source'], edge['target']))
    return result - selected_nodes


def enforce_elements(before, after, request):
    selected, permitted = set(request['elements']), set(request['permitted_neighbors'])
    a = {n['id']: n for n in before['nodes']}
    b = {n['id']: n for n in after['nodes']}
    removed_nodes = a.keys() - b.keys()
    geometry_nodes = (selected & a.keys()) | permitted
    for change in diff({'views': [before]}, {'views': [after]}):
        kind, eid, fields, action = change['kind'], change['id'], set(change['fields']), change['change']
        if kind == 'view':
            if not fields <= {'width', 'height'} or after['width'] < before['width'] or after['height'] < before['height']:
                raise ValueError('Elements scope keeps view text unchanged and permits canvas growth only')
        elif kind == 'group':
            raise ValueError('Elements scope keeps groups unchanged')
        elif action == 'added':
            raise ValueError('Elements scope cannot add nodes or edges; choose whole view scope')
        elif kind == 'node':
            if eid not in selected and not (action == 'changed' and eid in permitted and fields <= NODE_GEOMETRY):
                raise ValueError(f'Unselected node {eid} is immutable except permitted neighbor geometry')
        elif eid not in selected:
            edge = next(e for e in before['edges'] if e['id'] == eid)
            incident_removed = edge['source'] in removed_nodes or edge['target'] in removed_nodes
            incident_geometry = edge['source'] in geometry_nodes or edge['target'] in geometry_nodes
            if not ((action == 'removed' and incident_removed) or
                    (action == 'changed' and fields <= {'points'} and incident_geometry)):
                raise ValueError(f'Unselected edge {eid} may change only incident routing points')


def validate_citations(repo, before, after, full_views=()):
    old = {v['id']: v for v in before['views']}
    for view in after['views']:
        prior = old.get(view['id'])
        old_items = {(section, i['id']): i for section in ('nodes', 'edges')
                     for i in prior[section]} if prior else {}
        for section in ('nodes', 'edges'):
            for item in view[section]:
                previous = old_items.get((section, item['id']))
                for evidence in item['evidence']:
                    if view['id'] in full_views or previous is None or evidence not in previous['evidence']:
                        excerpt(repo, evidence)
