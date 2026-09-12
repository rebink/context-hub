from dataclasses import dataclass

@dataclass
class Greeter:
    prefix: str

    def greet(self, name: str) -> str:
        return format_message(self.prefix, name)

def format_message(prefix: str, name: str) -> str:
    return f"{prefix}, {name}!"
