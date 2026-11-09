import sys
import yaml

path = r'C:\Users\liket\.dsh\profiles\desktop\cordis.patch.yml'
with open(path, 'r', encoding='utf-8') as fh:
    raw = fh.read()

# The file uses cordis' `!!js` tag; register a permissive constructor.
class Permissive(yaml.SafeLoader):
    pass

Permissive.add_multi_constructor('', lambda loader, suffix, node: loader.construct_scalar(node)
                                 if isinstance(node, yaml.ScalarNode) else None)

doc = yaml.load(raw, Loader=Permissive)
print('YAML parsed OK, top-level type: %s' % type(doc).__name__)

# Walk to the freepi provider models.
def find_providers(node, found):
    if isinstance(node, dict):
        for k, v in node.items():
            if k == 'providers' and isinstance(v, dict):
                found.update(v)
            else:
                find_providers(v, found)
    elif isinstance(node, list):
        for item in node:
            find_providers(item, found)

found = {}
find_providers(doc, found)
names = sorted(found.keys())
print('providers: %s' % names)

fp = found.get('freepi')
if not fp:
    sys.exit('freepi provider not found')

vision = []
textonly = []
for m in fp.get('models', []):
    ins = m.get('input') or []
    if 'image' in ins:
        vision.append(m['id'])
    else:
        textonly.append(m['id'])

print('\nvision models (%d):' % len(vision))
for v in vision:
    print('  ' + v)
print('\ntext-only models (%d)' % len(textonly))
