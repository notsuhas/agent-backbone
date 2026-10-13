import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

CLI = Path(__file__).resolve().parents[1]/'bin/agent-backbone'

class Integration(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.home = self.root/'home'
        self.home.mkdir()
        self.env = os.environ.copy()
        self.env['HOME'] = str(self.home)
        self.env['AGENT_BACKBONE_SKILLSHARE'] = os.environ['AGENT_BACKBONE_SKILLSHARE']
        self.env['AGENT_BACKBONE_COMMAND'] = str(CLI)
        self.repo = self.root/'library'
        self.repo.mkdir()
        self.git(self.repo, 'init', '-b', 'main')
        (self.repo/'skills').mkdir()
        (self.repo/'instructions').mkdir()
        (self.repo/'instructions/global.md').write_text('Shared instruction v1\n')
        skill = self.repo/'skills/example'
        skill.mkdir()
        (skill/'SKILL.md').write_text('---\nname: example\ndescription: fixture\ndisable-model-invocation: true\n---\nVersion one\n')
        (skill/'support.txt').write_text('full skill asset\n')
        (self.repo/'backbone.json').write_text(json.dumps({'schema_version': 1, 'skills_dir': 'skills', 'instructions': [{'path': 'instructions/global.md', 'agents': ['claude', 'codex']}]}))
        self.commit(self.repo)
        remote = self.root/'remote.git'
        self.git(self.root, 'clone', '--bare', str(self.repo), str(remote))
        self.git(self.repo, 'remote', 'add', 'origin', str(remote))
        self.git(self.repo, 'push', '-u', 'origin', 'main')
        for agent in ['claude', 'codex']:
            binary = self.home/'.local/bin'/agent
            binary.parent.mkdir(parents=True, exist_ok=True)
            binary.write_text('#!/bin/sh\nprintf "original '+agent+' %s\\n" "$*"\n')
            binary.chmod(0o755)
        self.env['PATH'] = str(self.home/'.local/bin')+os.pathsep+self.env['PATH']

    def tearDown(self):
        self.temp.cleanup()

    def git(self, cwd, *args):
        process = subprocess.run(['git', *args], cwd=cwd, env=self.env, capture_output=True, text=True)
        self.assertEqual(process.returncode, 0, process.stderr)
        return process.stdout.strip()

    def commit(self, repo):
        self.git(repo, 'add', '.')
        self.git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-m', 'test: update fixture')

    def cli(self, *args, success=True):
        process = subprocess.run(['python3', str(CLI), *map(str, args)], env=self.env, capture_output=True, text=True, timeout=40)
        if success:
            self.assertEqual(process.returncode, 0, process.stderr)
        else:
            self.assertNotEqual(process.returncode, 0)
        return process

    def test_shared_dotfiles_instructions_assets_and_native_launch(self):
        global_file = self.home/'dotfiles/GLOBAL.md'
        global_file.parent.mkdir()
        global_file.write_text('Local preferences must survive.\n')
        for relative in ['.claude/CLAUDE.md', '.codex/AGENTS.md']:
            link = self.home/relative
            link.parent.mkdir()
            link.symlink_to(global_file)
        self.cli('configure', self.repo, '--no-background')
        for relative in ['.claude/CLAUDE.md', '.codex/AGENTS.md']:
            self.assertTrue((self.home/relative).is_symlink())
        text = global_file.read_text()
        self.assertIn('Local preferences must survive.', text)
        self.assertIn('Shared instruction v1', text)
        self.assertEqual(text.count('<!-- agent-backbone:begin -->'), 1)
        self.assertEqual((self.home/'.agents/skills/example/support.txt').read_text(), 'full skill asset\n')
        before = global_file.read_bytes()
        self.cli('configure', self.repo, '--no-background')
        self.assertEqual(global_file.read_bytes(), before)
        process = subprocess.run([str(self.home/'.local/bin/codex'), 'app-server', '--stdio'], env=self.env, capture_output=True, text=True, timeout=30)
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(process.stdout.strip(), 'original codex app-server --stdio')

    def test_foreign_skill_conflict_does_not_overwrite(self):
        existing = self.home/'.agents/skills/example'
        existing.mkdir(parents=True)
        (existing/'SKILL.md').write_text('Foreign installer content\n')
        result = self.cli('configure', self.repo, '--no-background', success=False)
        self.assertIn('Unmanaged destination', result.stderr)
        self.assertEqual((existing/'SKILL.md').read_text(), 'Foreign installer content\n')
        self.assertFalse((self.home/'.claude/skills/example').exists())

    def test_dirty_and_offline_startup_keeps_cached_instructions(self):
        self.cli('configure', self.repo, '--no-background')
        (self.repo/'instructions/global.md').write_text('Unpublished local edit\n')
        self.cli('sync', '--startup')
        status = json.loads((self.home/'.local/state/agent-backbone/status.json').read_text())
        self.assertEqual(status['status'], 'stale')
        self.assertIn('Unpublished', status['reason'])
        self.assertIn('Shared instruction v1', (self.home/'.codex/AGENTS.md').read_text())
        self.git(self.repo, 'restore', 'instructions/global.md')
        self.git(self.repo, 'remote', 'set-url', 'origin', str(self.root/'missing.git'))
        self.cli('sync', '--startup')
        self.assertTrue((self.home/'.agents/skills/example/SKILL.md').is_file())

    def test_adopt_preserves_installer_and_detects_instruction_conflict(self):
        self.cli('configure', self.repo, '--no-background')
        external = self.home/'.cursor/skills/external'
        external.mkdir(parents=True)
        (external/'SKILL.md').write_text('---\nname: external\ndescription: external fixture\n---\nOriginal body\n')
        (external/'script.py').write_text('print("asset")\n')
        self.cli('adopt', external, '--name', 'external')
        self.assertTrue((external/'script.py').exists())
        self.assertTrue((self.repo/'skills/external/script.py').exists())
        variant = self.home/'.codex/skills/external'
        variant.mkdir(parents=True)
        (variant/'SKILL.md').write_text('---\nname: external\ndescription: variant\n---\nDifferent body\n')
        report = json.loads(self.cli('inventory').stdout)
        self.assertIn('external', report['conflicting_instructions'])

    def test_remote_commit_refreshes_shared_instructions_and_new_skill(self):
        self.cli('configure', self.repo, '--no-background')
        writer = self.root/'writer'
        self.git(self.root, 'clone', str(self.root/'remote.git'), str(writer))
        (writer/'instructions/global.md').write_text('Shared instruction v2\n')
        new = writer/'skills/new-skill'
        new.mkdir()
        (new/'SKILL.md').write_text('---\nname: new-skill\ndescription: new fixture\n---\nNew body\n')
        self.commit(writer)
        self.git(writer, 'push')
        self.cli('sync')
        for relative in ['.claude/CLAUDE.md', '.codex/AGENTS.md']:
            self.assertIn('Shared instruction v2', (self.home/relative).read_text())
        self.assertTrue((self.home/'.agents/skills/new-skill/SKILL.md').is_file())

    def test_adopt_imports_installer_source_without_removing_original(self):
        self.cli('configure', self.repo, '--no-background')
        external = self.home/'.cursor/skills/external'
        external.mkdir(parents=True)
        (external/'SKILL.md').write_text('---\nname: external\ndescription: fixture\n---\nOriginal\n')
        (external.parent.parent/'.skill-lock.json').write_text(json.dumps({'version': 3, 'skills': {'external': {'source': 'example/vendor', 'sourceType': 'github', 'skillPath': 'skills/external/SKILL.md'}}}))
        self.cli('adopt', external, '--name', 'external')
        data = json.loads((self.repo/'backbone.json').read_text())
        self.assertEqual(data['packages'][0]['upstream']['repository'], 'https://github.com/example/vendor.git')
        self.assertEqual(data['packages'][0]['upstream']['path'], 'skills/external')
        self.assertTrue((external/'SKILL.md').exists())

    def test_upstream_update_preserves_host_adapter_and_tracks_new_skills(self):
        upstream = self.root/'upstream'
        upstream.mkdir()
        self.git(upstream, 'init', '-b', 'main')
        core = upstream/'plugin/skills/first'
        core.mkdir(parents=True)
        (core/'SKILL.md').write_text('---\nname: first\ndescription: first fixture\n---\nFirst\n')
        (upstream/'plugin/LICENSE').write_text('MIT fixture\n')
        self.commit(upstream)
        package = self.repo/'packages/demo'
        package.mkdir(parents=True)
        (package/'HOST.md').write_text('My adapter must survive\n')
        data = json.loads((self.repo/'backbone.json').read_text())
        data['packages'] = [{'name': 'demo', 'path': 'packages/demo', 'host_notes': 'HOST.md', 'local_files': ['HOST.md'], 'upstream': {'repository': str(upstream), 'path': 'plugin', 'ref': 'main'}}]
        (self.repo/'backbone.json').write_text(json.dumps(data))
        self.commit(self.repo)
        self.git(self.repo, 'push')
        self.cli('configure', self.repo, '--no-background')
        self.cli('upstream', 'update', 'demo')
        self.assertEqual((package/'HOST.md').read_text(), 'My adapter must survive\n')
        self.assertTrue((self.repo/'skills/first/SKILL.md').exists())
        updated = json.loads((self.repo/'backbone.json').read_text())
        self.assertEqual(updated['packages'][0]['upstream']['approved_tree'], self.git(upstream, 'rev-parse', 'HEAD:plugin'))
        self.assertTrue(self.git(self.repo, 'status', '--porcelain'))

if __name__ == '__main__':
    unittest.main()
