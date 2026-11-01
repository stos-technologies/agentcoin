class AgentCoinError(Exception):
    """Error with a stable machine-readable code (same codes as @agentcoin/core)."""

    def __init__(self, code: str, message: str, details=None):
        super().__init__(message)
        self.code = code
        self.details = details
