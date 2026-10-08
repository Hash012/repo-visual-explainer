#!/usr/bin/env python3
"""Behavior regressions for scoped proposals and source freshness, using invented files."""
import copy
import hashlib
import os
import json
import time
import unittest
from unittest.mock import patch

from serve import Bridge
import test_bridge as legacy
from test_bridge import MockBridge, fixture


class UpgradeTests(unittest.TestCase):
    setUp = legacy.BridgeTests.setUp
    tearDown = legacy.BridgeTests.tearDown
    request = legacy.BridgeTests.request
    ask = legacy.BridgeTests.ask
    edited_view = legacy.BridgeTests.edited_view

    def done(self, job):
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            status, result, _ = self.request('GET', '/api/jobs/' + job)
            self.assertEqual(status, 200, result)
            if result['status'] in ('done', 'error', 'preview'):
                return result
            time.sleep(0.01)
        self.fail('Job did not finish')

    def authority(self):
        return copy.deepcopy((self.bridge.atlas, self.bridge.messages, self.bridge.history)), (
            self.bridge.state_path.read_bytes() if self.bridge.state_path.exists() else None)

    def replace_seed(self, atlas):
        self.bridge.close()
        self.seed.write_text(json.dumps(atlas))
        self.bridge = MockBridge(self.repo, self.seed)
        self.bridge.gate, self.bridge.failure = None, None
        self.bridge.response = {'answer': 'Checked the source.', 'replacement_view': None, 'new_views': []}
        self.server.bridge = self.bridge

    def proposal(self, **changes):
        self.bridge.response['replacement_view'] = self.edited_view()
        result = self.done(self.ask('edit', preview=True, elements=['source'], **changes))
        self.assertEqual(result['status'], 'preview', result)
        return result

    def test_legacy_ask_still_commits_and_persists_v2(self):
        self.bridge.response['replacement_view'] = self.edited_view()
        result = self.done(self.ask('edit'))
        self.assertEqual(result['status'], 'done', result)
        self.assertEqual(self.bridge.atlas['revision'], 1)
        self.assertEqual(len(self.bridge.messages), 2)
        self.assertEqual(len(self.bridge.history), 1)
        self.assertEqual(json.loads(self.bridge.state_path.read_text())['version'], 2)

    def test_elements_scope_rejects_unrelated_semantics_and_topology_atomically(self):
        before = self.authority()
        for field, value in [('label', 'Changed consumer'), ('detail', 'Invented unrelated assertion'),
                             ('status', 'planned'), ('summary', 'New unrelated meaning')]:
            with self.subTest(field=field):
                view = self.edited_view()
                view['nodes'][1][field] = value
                self.bridge.response['replacement_view'] = view
                result = self.done(self.ask('edit', elements=['source'], permitted_neighbors=['consumer']))
                self.assertEqual(result['status'], 'error', result)
                self.assertEqual(self.authority(), before)
        view = self.edited_view()
        view['edges'][0]['label'] = 'Unselected relation changed'
        self.bridge.response['replacement_view'] = view
        self.assertEqual(self.done(self.ask('edit', elements=['source']))['status'], 'error')
        view = self.edited_view()
        extra = copy.deepcopy(view['nodes'][1])
        extra.update(id='extra', x=550)
        view['nodes'].append(extra)
        self.bridge.response['replacement_view'] = view
        self.assertEqual(self.done(self.ask('edit', elements=['source']))['status'], 'error')
        self.bridge.response['replacement_view'] = self.edited_view()
        extra_view = copy.deepcopy(fixture()['views'][0])
        extra_view['id'] = 'extra_view'
        self.bridge.response['new_views'] = [extra_view]
        self.assertEqual(self.done(self.ask('edit', elements=['source']))['status'], 'error')
        self.assertEqual(self.authority(), before)

    def test_neighbor_geometry_requires_explicit_permission(self):
        view = self.edited_view()
        view['nodes'][1]['x'] = 340
        self.bridge.response['replacement_view'] = view
        self.assertEqual(self.done(self.ask('edit', elements=['source']))['status'], 'error')
        result = self.done(self.ask('edit', elements=['source'], permitted_neighbors=['consumer']))
        self.assertEqual(result['status'], 'done', result)
        self.assertEqual(self.bridge.atlas['views'][0]['nodes'][1]['x'], 340)

    def test_geometry_permission_cannot_extend_to_disconnected_node(self):
        atlas = fixture()
        remote = copy.deepcopy(atlas['views'][0]['nodes'][1])
        remote.update(id='remote', x=550)
        atlas['views'][0]['nodes'].append(remote)
        self.replace_seed(atlas)
        before = self.authority()
        status, result, _ = self.request('POST', '/api/ask', {
            'mode': 'edit', 'view': 'overview', 'elements': ['source'],
            'question': 'Improve the selected source.', 'revision': 0,
            'permitted_neighbors': ['remote']})
        self.assertEqual(status, 400, result)
        self.assertEqual(self.authority(), before)

    def test_selected_deletion_allows_only_incident_edge_cleanup(self):
        view = copy.deepcopy(fixture()['views'][0])
        view['nodes'] = [view['nodes'][1]]
        view['edges'] = []
        self.bridge.response['replacement_view'] = view
        result = self.done(self.ask('edit', elements=['source']))
        self.assertEqual(result['status'], 'done', result)
        self.assertEqual([n['id'] for n in self.bridge.atlas['views'][0]['nodes']], ['consumer'])

    def test_preview_discard_and_apply_authority(self):
        before = self.authority()
        proposal = self.proposal()
        self.assertEqual(self.authority(), before)
        self.assertEqual(proposal['base_revision'], 0)
        self.assertEqual(proposal['candidate']['views'][0]['nodes'][0]['summary'], 'Produces the source value.')
        self.assertTrue(any(change['id'] == 'source' and 'summary' in change['fields'] for change in proposal['diff']))
        status, result, _ = self.request('POST', '/api/discard', {'proposal': proposal['proposal']})
        self.assertEqual(status, 200, result)
        self.assertEqual(self.authority(), before)
        self.assertEqual(self.request('POST', '/api/apply', {'proposal': proposal['proposal'], 'revision': 0})[0], 404)
        proposal = self.proposal()
        status, result, _ = self.request('POST', '/api/apply', {'proposal': proposal['proposal'], 'revision': 0})
        self.assertEqual(status, 200, result)
        self.assertEqual(self.bridge.atlas['revision'], 1)
        self.assertEqual(len(self.bridge.messages), 2)
        self.assertEqual(len(self.bridge.history), 1)
        self.assertEqual(self.request('POST', '/api/apply', {'proposal': proposal['proposal'], 'revision': 1})[0], 404)

    def test_apply_detects_source_change_even_with_unknown_baseline(self):
        proposal = self.proposal()
        before = self.authority()
        (self.repo / 'example.py').write_text('def source():\n    return 9\n')
        status, result, _ = self.request('POST', '/api/apply', {'proposal': proposal['proposal'], 'revision': 0})
        self.assertEqual(status, 409, result)
        self.assertEqual(self.authority(), before)

    def test_apply_detects_revision_change(self):
        proposal = self.proposal()
        self.bridge.response['replacement_view'] = self.edited_view()
        self.assertEqual(self.done(self.ask('edit'))['status'], 'done')
        before = self.authority()
        status, result, _ = self.request('POST', '/api/apply', {'proposal': proposal['proposal'], 'revision': 1})
        self.assertEqual(status, 409, result)
        self.assertEqual(self.authority(), before)

    def test_apply_disk_failure_preserves_proposal_and_authority(self):
        self.assertEqual(self.done(self.ask())['status'], 'done')
        proposal = self.proposal()
        before = self.authority()
        with patch('serve.atomic_json', side_effect=OSError('Disk full')):
            status, result, _ = self.request('POST', '/api/apply', {'proposal': proposal['proposal'], 'revision': 0})
        self.assertEqual(status, 500, result)
        self.assertEqual(self.authority(), before)
        self.assertIn(proposal['proposal'], self.bridge.state()['proposals'])
        self.assertEqual(self.request('POST', '/api/apply', {'proposal': proposal['proposal'], 'revision': 0})[0], 200)

    def test_missing_current_source_does_not_block_startup_or_unrelated_edit(self):
        atlas = fixture()
        unrelated = copy.deepcopy(atlas['views'][0])
        unrelated['id'] = 'unrelated'
        unrelated['nodes'][0]['evidence'][0]['path'] = 'missing.py'
        atlas['views'].append(unrelated)
        self.replace_seed(atlas)
        self.assertEqual(self.bridge.state()['freshness']['unrelated']['status'], 'unavailable')
        self.bridge.response['replacement_view'] = self.edited_view()
        result = self.done(self.ask('edit'))
        self.assertEqual(result['status'], 'done', result)
        self.assertEqual(self.bridge.atlas['views'][1], unrelated)
        self.bridge.close()
        restored = Bridge(self.repo, self.seed)
        try:
            self.assertEqual(restored.atlas['views'][1], unrelated)
            self.assertEqual(restored.state()['freshness']['unrelated']['status'], 'unavailable')
        finally:
            restored.close()

    def test_undo_restores_graph_with_missing_historical_source_as_unavailable(self):
        (self.repo / 'current.py').write_text('def source():\n    return 8\n')
        view = self.edited_view()
        view['nodes'][0]['evidence'][0]['path'] = 'current.py'
        self.bridge.response['replacement_view'] = view
        self.assertEqual(self.done(self.ask('edit'))['status'], 'done')
        messages = copy.deepcopy(self.bridge.messages)
        (self.repo / 'example.py').unlink()
        status, result, _ = self.request('POST', '/api/undo', {'revision': 1})
        self.assertEqual(status, 200, result)
        self.assertEqual(self.bridge.messages, messages)
        self.assertEqual(self.bridge.atlas['views'], fixture()['views'])
        self.assertEqual(self.bridge.state()['freshness']['overview']['status'], 'unavailable')

    def refresh(self, views, **changes):
        request = {'revision': self.bridge.atlas['revision'], 'views': views}
        request.update(changes)
        status, result, _ = self.request('POST', '/api/refresh', request)
        self.assertEqual(status, 202, result)
        return self.done(result['job'])

    def current_response(self, request, atlas, recent):
        view = next(v for v in atlas['views'] if v['id'] == request['view'])
        return {'answer': 'Revalidated against current source.',
                'replacement_view': copy.deepcopy(view), 'new_views': []}

    def test_source_hashes_cover_full_cited_files_and_refresh_only_requested_views(self):
        atlas = fixture()
        second = copy.deepcopy(atlas['views'][0])
        second['id'] = 'second'
        atlas['views'].append(second)
        self.replace_seed(atlas)
        self.assertEqual(self.bridge.state()['freshness']['overview']['status'], 'unknown')
        self.assertEqual(self.bridge.state()['freshness']['second']['status'], 'unknown')
        with patch.object(self.bridge, 'invoke_codex', side_effect=self.current_response):
            result = self.refresh(['overview', 'second'])
        self.assertEqual(result['status'], 'done', result)
        self.assertEqual(self.bridge.atlas['revision'], 1)
        self.assertEqual(self.bridge.state()['freshness']['overview']['status'], 'fresh')
        self.assertEqual(self.bridge.state()['freshness']['second']['status'], 'fresh')
        # A change outside the cited two lines still changes the cited file's SHA256.
        with (self.repo / 'example.py').open('a') as stream:
            stream.write('# uncited new line\n')
        before = self.authority()
        status, result, _ = self.request('POST', '/api/source-check', {'revision': 1})
        self.assertEqual(status, 200, result)
        self.assertEqual(result['freshness']['overview']['status'], 'stale')
        self.assertEqual(result['freshness']['second']['status'], 'stale')
        self.assertEqual(result['freshness']['overview']['changed_paths'], ['example.py'])
        self.assertEqual(self.authority(), before)
        self.assertIn('cited', result['coverage'].lower())
        with patch.object(self.bridge, 'invoke_codex', side_effect=self.current_response):
            result = self.refresh(['overview'])
        self.assertEqual(result['status'], 'done', result)
        self.assertEqual(self.bridge.atlas['views'][1], second)
        self.assertEqual(self.bridge.state()['freshness']['overview']['status'], 'fresh')
        self.assertEqual(self.bridge.state()['freshness']['second']['status'], 'stale')
        (self.repo / 'example.py').unlink()
        result = self.request('POST', '/api/source-check', {'revision': 2})[1]
        self.assertEqual(result['freshness']['overview']['status'], 'unavailable')
        self.assertEqual(result['freshness']['overview']['unavailable_paths'], ['example.py'])

    def test_refresh_preview_keeps_baselines_and_undo_restores_them(self):
        with patch.object(self.bridge, 'invoke_codex', side_effect=self.current_response):
            result = self.refresh(['overview'], preview=True)
        self.assertEqual(result['status'], 'preview', result)
        self.assertEqual(self.bridge.atlas['revision'], 0)
        self.assertEqual(self.bridge.state()['freshness']['overview']['status'], 'unknown')
        self.assertFalse(self.bridge.state_path.exists())
        self.assertEqual(self.bridge.messages, [])
        self.assertEqual(self.bridge.history, [])
        status, applied, _ = self.request('POST', '/api/apply', {'proposal': result['proposal'], 'revision': 0})
        self.assertEqual(status, 200, applied)
        self.assertEqual(self.bridge.state()['freshness']['overview']['status'], 'fresh')
        (self.repo / 'example.py').write_text('def source():\n    return 9\n')
        with patch.object(self.bridge, 'invoke_codex', side_effect=self.current_response):
            result = self.refresh(['overview'])
        self.assertEqual(result['status'], 'done', result)
        self.assertEqual(self.bridge.state()['freshness']['overview']['status'], 'fresh')
        messages = copy.deepcopy(self.bridge.messages)
        status, result, _ = self.request('POST', '/api/undo', {'revision': 2})
        self.assertEqual(status, 200, result)
        self.assertEqual(self.bridge.messages, messages)
        self.assertEqual(self.bridge.state()['freshness']['overview']['status'], 'stale')
        self.bridge.close()
        restored = Bridge(self.repo, self.seed)
        try:
            self.assertEqual(restored.state()['freshness']['overview']['status'], 'stale')
        finally:
            restored.close()

    def test_multiview_refresh_failure_is_one_transaction(self):
        atlas = fixture()
        second = copy.deepcopy(atlas['views'][0])
        second['id'] = 'second'
        atlas['views'].append(second)
        self.replace_seed(atlas)
        self.assertEqual(self.done(self.ask())['status'], 'done')
        before = self.authority()
        def fail_second(request, current, recent):
            if request['view'] == 'second':
                raise ValueError('Second source analysis failed')
            return self.current_response(request, current, recent)
        with patch.object(self.bridge, 'invoke_codex', side_effect=fail_second):
            result = self.refresh(['overview', 'second'])
        self.assertEqual(result['status'], 'error', result)
        self.assertEqual(self.authority(), before)
        self.assertEqual(self.bridge.state()['freshness']['overview']['status'], 'unknown')
        with patch.object(self.bridge, 'invoke_codex', side_effect=self.current_response), patch(
                'serve.atomic_json', side_effect=OSError('Disk full')):
            result = self.refresh(['overview', 'second'])
        self.assertEqual(result['status'], 'error', result)
        self.assertEqual(self.authority(), before)
        self.assertEqual(self.bridge.state()['freshness']['overview']['status'], 'unknown')

    def test_v1_migration_does_not_invent_source_baseline(self):
        self.bridge.close()
        legacy = {'version': 1, 'repo': str(self.repo), 'atlas': fixture(), 'messages': [], 'history': []}
        original_bytes = ('\n  ' + json.dumps(legacy, indent=3, ensure_ascii=False) + '\n\n').encode('utf-8')
        self.bridge.state_path.write_bytes(original_bytes)
        self.bridge = MockBridge(self.repo, self.seed)
        self.bridge.gate, self.bridge.failure = None, None
        self.bridge.response = {'answer': 'Checked source.', 'replacement_view': None, 'new_views': []}
        self.server.bridge = self.bridge
        self.assertEqual(self.bridge.state()['freshness']['overview']['status'], 'unknown')
        self.assertEqual(json.loads(self.bridge.state_path.read_text())['version'], 1)
        self.assertEqual(self.done(self.ask())['status'], 'done')
        self.assertEqual(json.loads(self.bridge.state_path.read_text())['version'], 2)
        backup = self.bridge.state_path.with_name(self.bridge.state_path.name + '.v1.backup.json')
        self.assertEqual(backup.read_bytes(), original_bytes)
        self.assertEqual(json.loads(backup.read_text()), legacy)

    def test_second_upgrade_preserves_each_distinct_v1_backup(self):
        self.bridge.close()
        legacy = {'version': 1, 'repo': str(self.repo), 'atlas': fixture(), 'messages': [], 'history': []}
        first_bytes = (json.dumps(legacy, indent=2) + '\n').encode('utf-8')
        state_path = self.bridge.state_path
        state_path.write_bytes(first_bytes)
        self.bridge = MockBridge(self.repo, self.seed)
        self.bridge.gate, self.bridge.failure = None, None
        self.bridge.response = {'answer': 'First upgrade.', 'replacement_view': None, 'new_views': []}
        self.server.bridge = self.bridge
        self.assertEqual(self.done(self.ask())['status'], 'done')
        fixed_backup = state_path.with_name(state_path.name + '.v1.backup.json')
        self.assertEqual(fixed_backup.read_bytes(), first_bytes)
        self.bridge.close()
        # An older bridge resumes from its backup and saves a distinct valid v1 state.
        legacy['atlas']['summary'] = 'Updated by the older bridge after rollback.'
        second_bytes = ('\n' + json.dumps(legacy, indent=4) + '\n\n').encode('utf-8')
        state_path.write_bytes(second_bytes)
        self.bridge = MockBridge(self.repo, self.seed)
        self.bridge.gate, self.bridge.failure = None, None
        self.bridge.response = {'answer': 'Second upgrade.', 'replacement_view': None, 'new_views': []}
        self.server.bridge = self.bridge
        result = self.done(self.ask())
        self.assertEqual(result['status'], 'done', result)
        self.assertEqual(json.loads(state_path.read_text())['version'], 2)
        self.assertEqual(self.bridge.atlas['summary'], legacy['atlas']['summary'])
        self.assertEqual(fixed_backup.read_bytes(), first_bytes)
        backups = [path for path in state_path.parent.iterdir()
                   if path.name.startswith(state_path.name) and path != state_path
                   and path.is_file() and path != fixed_backup and not path.name.endswith('.lock')]
        self.assertEqual([path.read_bytes() for path in backups], [second_bytes])

    def test_migration_backup_targets_reject_symlinks_and_fifos(self):
        self.bridge.close()
        legacy = {'version': 1, 'repo': str(self.repo), 'atlas': fixture(), 'messages': [], 'history': []}
        original_bytes = json.dumps(legacy, indent=2).encode('utf-8')
        state_path = self.bridge.state_path
        state_path.write_bytes(original_bytes)
        self.bridge = MockBridge(self.repo, self.seed)
        self.bridge.gate, self.bridge.failure = None, None
        self.bridge.response = {'answer': 'Attempt upgrade.', 'replacement_view': None, 'new_views': []}
        self.server.bridge = self.bridge
        fixed = state_path.with_name(state_path.name + '.v1.backup.json')
        sentinel = self.base / 'sentinel'
        sentinel.write_bytes(b'untouched')
        before = self.authority()
        for kind in ('fixed_symlink', 'fixed_fifo', 'fallback_symlink'):
            with self.subTest(kind=kind):
                fallback = None
                if kind == 'fixed_symlink':
                    fixed.symlink_to(sentinel)
                elif kind == 'fixed_fifo':
                    os.mkfifo(fixed)
                else:
                    fixed.write_bytes(b'earlier distinct backup')
                    digest = hashlib.sha256(original_bytes).hexdigest()
                    fallback = state_path.with_name(state_path.name + '.v1.' + digest + '.backup.json')
                    fallback.symlink_to(sentinel)
                try:
                    result = self.done(self.ask())
                    self.assertEqual(result['status'], 'error', result)
                    self.assertEqual(self.authority(), before)
                    self.assertEqual(sentinel.read_bytes(), b'untouched')
                finally:
                    fixed.unlink()
                    if fallback is not None:
                        fallback.unlink()


if __name__ == '__main__':
    unittest.main()
