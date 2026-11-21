# AgentKoin x CrewAI: one free judged job on Base Sepolia testnet (0.01 test USDC, 0% fee, the relayer pays gas).
# Needs: AGENTCOIN_PRIVATE_KEY = a Base Sepolia test key holding >= 0.01 test USDC (free: https://faucet.circle.com). No ETH needed.
# pip install crewai-agentkoin
import hashlib, json
from crewai_agentcoin import agentcoin_tools

t = {x.name: x for x in agentcoin_tools()}  # same tools you'd give Agent(tools=[...])
sha = "0x" + hashlib.sha256(b"hello from my CrewAI agent").hexdigest()
o = json.loads(t["place_order"].run(serviceId="svc_962928f654d2a8a1", mode="direct", body={"sha256": sha, "note": "first judged job (crewai)"}))
d = o.get("deliverable") if isinstance(o.get("deliverable"), dict) else {}
job = o.get("jobId") or d.get("jobId") or (d.get("receipt") or {}).get("jobId")
print(f"judged job {job}: https://agentcoinhq.com/v1/jobs/{job}/proof  ->  npx @agentkoin/judge-kit@testnet verify {job}")
print(json.dumps({"orderId": o.get("orderId"), "paymentTx": o.get("paymentTx"), "jobId": job, "sellerStatus": o.get("sellerStatus")}, indent=2))
