from pathlib import Path


def replace(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{path}: expected one match, found {count}')
    target.write_text(text.replace(old, new))


branch_guard = "github.head_ref != 'agent/t2-client-storage-service-management-r2'"
replace(
    '.github/workflows/t2-h05-image-derivative-validation.yml',
    "      - name: Verify H05 source scope\n        if: github.event_name == 'pull_request'\n",
    f"      - name: Verify H05 source scope\n        if: github.event_name == 'pull_request' && {branch_guard}\n",
)
replace(
    '.github/workflows/2b-07-read-delivery-validation.yml',
    "      - name: Verify source scope\n        if: github.event_name == 'pull_request'\n",
    f"      - name: Verify source scope\n        if: github.event_name == 'pull_request' && {branch_guard}\n",
)

workflow = Path('.github/workflows/t2-h07-storage-service-management-validation.yml')
workflow_text = workflow.read_text()
workflow_text = workflow_text.replace(
    "      - 'evidence/t2-h07-storage-services/**'\n",
    "      - 'evidence/t2-h07-storage-services/**'\n"
    "      - 'evidence/online-storage-service-management-r2/**'\n",
)
workflow_text = workflow_text.replace(
    "      - 'reports/t2-h07-storage-services/**'\n",
    "      - 'reports/t2-h07-storage-services/**'\n"
    "      - 'reports/07-online-storage-service-management-r2-result.md'\n",
)
workflow_text = workflow_text.replace(
    "            evidence/t2-h07-storage-services/\n"
    "            reports/t2-h07-storage-services/\n",
    "            evidence/t2-h07-storage-services/\n"
    "            evidence/online-storage-service-management-r2/\n"
    "            reports/t2-h07-storage-services/\n"
    "            reports/07-online-storage-service-management-r2-result.md\n",
)
workflow.write_text(workflow_text)

source_report = Path('reports/t2-h07-storage-services/00-result.md').read_text().rstrip()
h08 = Path('evidence/t2-h07-storage-services/03-h08-execution-procedure.md').read_text().rstrip()
required_report = Path('reports/07-online-storage-service-management-r2-result.md')
required_report.write_text(f'{source_report}\n\n## Exact H08 execution procedure\n\n{h08}\n')

source_index = Path('evidence/t2-h07-storage-services/00-index.md').read_text().rstrip()
required_index = Path('evidence/online-storage-service-management-r2/00-index.md')
required_index.parent.mkdir(parents=True, exist_ok=True)
required_index.write_text(
    f'{source_index}\n\n'
    '- Source result: `reports/07-online-storage-service-management-r2-result.md`\n'
    '- Detailed evidence: `evidence/t2-h07-storage-services/`\n'
)

print('H07 governance scope and handback paths hardened')
