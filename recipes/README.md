# Recipes

https://github.com/user-attachments/assets/9454662f-2648-4928-8723-f7d52e94e9b8

Step-by-step builds that add a new capability to your Open Brain. Follow the instructions, run the code, get a new feature.

| Recipe | What It Does |
| ------ | ------------ |
| [Email History Import](email-history-import/) | Pull an IMAP mailbox into searchable thoughts or watch an inbox continuously |
| [ChatGPT Conversation Import](chatgpt-conversation-import/) | Ingest your ChatGPT data export |
| [Claude Conversation Import](claude-conversation-import/) | Ingest your Claude data export |
| [Claim Typing](claim-typing/) | Evaluate and tune derived claim metadata for distilled chat memories |
| [Document Import](document-import/) | Convert local documents with Docling and ingest searchable chunks into OB1 |
| [Daily Digest](daily-digest/) | Automated summary of recent thoughts via email or Slack |

Utilities:
- [prompt-autoresearch.py](prompt-autoresearch.py) tunes a single mutable artifact such as a prompt, JSON policy, or PRD against a fixed evaluator.
- [code-autoresearch.py](code-autoresearch.py) mutates an explicit allowlist of files in a temp overlay workspace and only writes back accepted revisions that improve train without regressing guard suites.

## Contributing

Recipes are open for community contributions. See [CONTRIBUTING.md](../CONTRIBUTING.md) for details.
