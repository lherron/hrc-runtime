import json


class Gap(Exception):
    """Required raw evidence was not captured."""


def exact(a, b):
    return json.dumps(a, sort_keys=True, ensure_ascii=True, separators=(',', ':')) == json.dumps(b, sort_keys=True, ensure_ascii=True, separators=(',', ':'))
