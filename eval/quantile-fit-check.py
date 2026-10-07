"""Synthetic CLI checks; never reads workload data."""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent


def pin(path):
    return {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}


with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)

    def save(name, value, lines=False):
        path = root / name
        path.write_text(''.join(json.dumps(r) + '\n' for r in value) if lines else json.dumps(value))
        return pin(path)

    cases = save('cases', [{'id': str(i)} for i in range(166)], True)
    labels = save('labels', [{'id': str(i), 'parsed': {'effort': {'answer': 'high'}}} for i in range(166)], True)
    inventory = save('inventory', {'families': {'router': {'pins': {
        'router-dev-s1001.jsonl': labels, 'router-dev.scrubbed.jsonl': cases}}}})
    validity = save('validity', {'complete': True, 'problems': []})
    for scenario, probabilities, level, expected in [
            ('feasible', {'low': 0, 'medium': .96, 'high': .04, 'xhigh': 0}, 'medium', .97),
            ('infeasible', {'low': 1, 'medium': 0, 'high': 0, 'xhigh': 0}, 'low', None),
            ('ties', {'low': 0, 'medium': 0, 'high': 1, 'xhigh': 0}, 'high', .95)]:
        manifest = {'inventory': inventory, 'validity': validity, 'labels': labels, 'cases': cases}
        identity = {'complete': True, 'results': []}
        for arm in ('base', 'candidate'):
            manifest[arm] = {'model': arm, 'passes': []}
            p = {'low': 0, 'medium': 0, 'high': 0, 'xhigh': 1} if arm == 'base' else probabilities
            routed = 'xhigh' if arm == 'base' else level
            for slot in range(2):
                raw = save(f'{scenario}-{arm}-{slot}-raw', [{'status': 200, 'response': {'model': arm}}], True)
                combined = save(f'{scenario}-{arm}-{slot}-combined', [
                    {'id': str(i), 'route': {'level': routed}, 'probabilities': p, 'workProbabilities': p}
                    for i in range(166)], True)
                identity['results'].append({'identity': True, 'input_sha256': combined['sha256']})
                manifest[arm]['passes'].append({'raw': raw, 'combined': combined})
        manifest['identity'] = save(f'{scenario}-identity', identity)
        source = save(f'{scenario}-manifest', manifest)
        output = root / f'{scenario}-result'
        subprocess.run(['bun', str(HERE / 'quantile-fit.ts'), source['path'], str(output)],
                       check=True, capture_output=True, text=True)
        result = json.loads(output.read_text())
        assert result['selected'] == expected, (scenario, result)
        assert result['feasible'] == (expected is not None)
        assert len(result['grid']['candidate']) == 5
        assert result['baseTarget']['below'] == 0
    print('PASS: feasible boundary, infeasible grid, smallest-q tie break; synthetic data only')
