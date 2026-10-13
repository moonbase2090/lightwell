"""def not_a_function():
    pass
"""
import json
from .nested.worker import run
from typing import Optional

def load_widget(name: str) -> str:
    def hidden():
        return name
    return name

class Widget:
    def method(self):
        pass

@decorator
async def refresh():
    return None
