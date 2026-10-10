# Publishing the site

`deploy.py` uploads the website to the GoDaddy host over FTPS, keeps a copy of
whatever it replaces, reads every file back to verify it, and requests each
uploaded page over HTTPS. It needs Python 3.8 or newer and nothing else.

## One-time setup

1. Copy `.env.deploy.example` to `.env.deploy` in the repository root and fill
   in the FTP username and password from cPanel (FTP Accounts). The file is
   ignored by git; never commit it.
2. Preview what would be sent:

       python3 tools/deploy.py --dry-run

## Publishing

    python3 tools/deploy.py                          # every site file
    python3 tools/deploy.py --changed-since 4f0dd93  # only what changed since a commit
    python3 tools/deploy.py --only partners.html contact.php

Tests, this folder, and dotfiles are never uploaded.

## Rolling back

Each run saves the server's previous copy of every replaced file under
`.deploy-backup/<timestamp>/` (ignored by git). To put those back:

    python3 tools/deploy.py --restore .deploy-backup/<timestamp>

## If the connection fails

- Certificate did not verify: shared hosts often present a certificate for the
  server's own hostname. Set `SRXS_FTP_HOST` to the hostname cPanel shows, or
  set `SRXS_FTP_TLS_VERIFY=0` to stay encrypted without checking the name.
- Host offers no FTPS: set `SRXS_FTP_TLS=0` for plain FTP.
- Files land in the wrong folder: set `SRXS_FTP_REMOTE_DIR` to the document
  root (for example `/public_html`). By default the script looks for
  `public_html`, `httpdocs` or `htdocs` under the FTP login directory and
  otherwise uploads into the login directory itself.
