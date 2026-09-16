import unittest
from typer.testing import CliRunner
from stackpilot_cli.cli import app
from stackpilot_cli.config import load_config, save_config, DEFAULT_CONFIG
from stackpilot_cli.services.docker_service import is_docker_installed, is_docker_running
from stackpilot_cli.services.ai_client import AIClient
from stackpilot_cli.services.backend_client import BackendClient

runner = CliRunner()

class TestStackPilotCLI(unittest.TestCase):
    def test_cli_help(self):
        result = runner.invoke(app, ["--help"])
        self.assertEqual(result.exit_code, 0)
        self.assertIn("StackPilot 100% Terminal CLI", result.output)

    def test_cli_version(self):
        result = runner.invoke(app, ["--version"])
        self.assertEqual(result.exit_code, 0)
        self.assertIn("version", result.output.lower())

    def test_config_operations(self):
        cfg = load_config()
        self.assertIsInstance(cfg, dict)
        self.assertIn("backend_url", cfg)
        self.assertIn("ai_service_url", cfg)

    def test_docker_detection(self):
        installed = is_docker_installed()
        self.assertTrue(installed)

    def test_ai_client_health(self):
        client = AIClient()
        health = client.check_health()
        self.assertEqual(health.get("status"), "ok")

    def test_backend_client_health(self):
        client = BackendClient()
        health = client.check_health()
        self.assertEqual(health.get("status"), "ok")

    def test_status_command(self):
        result = runner.invoke(app, ["status"])
        self.assertEqual(result.exit_code, 0)
        self.assertIn("StackPilot Running Containers", result.output)

    def test_test_command_help(self):
        result = runner.invoke(app, ["test", "--help"])
        self.assertEqual(result.exit_code, 0)
        self.assertIn("--open", result.output)
        self.assertIn("Run autonomous browser QA crawl", result.output)

if __name__ == "__main__":
    unittest.main()
