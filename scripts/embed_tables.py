#!/usr/bin/env python3
"""
Embed extracted table images using nomic-embed-vision-v1.5.
Shares a joint latent space with nomic-embed-text-v1.5 (served as nomic-embed-text in Ollama),
enabling direct cosine similarity between text and image embeddings.

Install: pip install transformers torch Pillow einops
Usage:   python3 embed_tables.py <tables_json_path> <output_json_path>

Input:  JSON array from extract_tables.py — each entry has image_data (base64 JPEG).
Output: Same array with an `embedding` field added to each entry. image_data and data
(the extracted table rows) are kept for downstream use as image/text context.
"""

import sys
import json
import base64
import io

try:
    import torch
    import torch.nn.functional as F
    from transformers import AutoImageProcessor, AutoModel, AutoConfig
    from PIL import Image
except ImportError as e:
    print(
        f'Missing dependency: {e}.\n'
        f'Run: {sys.executable} -m pip install transformers torch Pillow einops',
        file=sys.stderr,
    )
    sys.exit(2)

MODEL_NAME = "nomic-ai/nomic-embed-vision-v1.5"


def _patch_config_cache():
    """Download config.json via transformers (no Pydantic validation) and fix
    whole-number floats to ints before AutoConfig's Pydantic v2 validation runs."""
    try:
        from transformers.utils import cached_file
        config_path = cached_file(MODEL_NAME, "config.json")
        with open(config_path) as f:
            config_dict = json.load(f)
        fixed = {k: int(v) if isinstance(v, float) and v.is_integer() else v
                 for k, v in config_dict.items()}
        if fixed != config_dict:
            with open(config_path, "w") as f:
                json.dump(fixed, f)
            print(f'Patched config.json (float→int fields)', file=sys.stderr)
    except Exception as e:
        print(f'Warning: could not patch config: {e}', file=sys.stderr)


def load_model():
    print(f'Loading {MODEL_NAME}...', file=sys.stderr)
    _patch_config_cache()
    processor = AutoImageProcessor.from_pretrained(MODEL_NAME)
    config = AutoConfig.from_pretrained(MODEL_NAME, trust_remote_code=True)
    model = AutoModel.from_pretrained(MODEL_NAME, config=config, trust_remote_code=True)
    model.eval()
    return processor, model


def decode_image(image_data):
    _, b64 = image_data.split(',', 1)
    raw = base64.b64decode(b64)
    return Image.open(io.BytesIO(raw)).convert('RGB')


def embed_images(processor, model, images):
    inputs = processor(images=images, return_tensors='pt', padding=True)
    with torch.no_grad():
        outputs = model(**inputs)
    embeddings = outputs.last_hidden_state[:, 0]  # CLS token
    embeddings = F.normalize(embeddings, p=2, dim=1)
    return embeddings.tolist()


if __name__ == '__main__':
    if len(sys.argv) != 3:
        print('Usage: embed_tables.py <tables_json_path> <output_json_path>', file=sys.stderr)
        sys.exit(1)

    try:
        with open(sys.argv[1], 'r') as f:
            tables = json.load(f)

        if not tables:
            with open(sys.argv[2], 'w') as f:
                json.dump([], f)
            print('No tables to embed.', file=sys.stderr)
            sys.exit(0)

        processor, model = load_model()

        print(f'Embedding {len(tables)} tables...', file=sys.stderr)
        images = []
        for tab in tables:
            try:
                images.append(decode_image(tab['image_data']))
            except Exception as e:
                print(f'Warning: could not decode image for {tab.get("label")}: {e}', file=sys.stderr)
                images.append(Image.new('RGB', (224, 224)))  # blank placeholder

        embeddings = embed_images(processor, model, images)

        output = []
        for tab, emb in zip(tables, embeddings):
            output.append({
                'page_num': tab['page_num'],
                'table_num': tab['table_num'],
                'label': tab['label'],
                'caption': tab['caption'],
                'data': tab['data'],
                'embedding': emb,
                'image_data': tab['image_data'],
                'position': tab.get('position'),
            })

        with open(sys.argv[2], 'w') as f:
            json.dump(output, f)

        print(f'Done — embedded {len(output)} tables.', file=sys.stderr)

    except Exception as e:
        print(f'Error: {e}', file=sys.stderr)
        sys.exit(1)
