from langgraph.graph import StateGraph, START, END
from langchain_core.tools import tool

@tool
def web_search(q: str): ...
@tool
def read_file(path: str): ...
@tool
def python_repl(code: str): ...   # code execution → reaches secrets/env

research_llm = llm.bind_tools([web_search, read_file])
coder_llm   = llm.bind_tools([python_repl])

graph = StateGraph(State)
graph.add_node("supervisor", supervisor_fn)
graph.add_node("researcher", researcher_fn)
graph.add_node("coder", coder_fn)
graph.add_edge(START, "supervisor")
graph.add_edge("supervisor", "researcher")
graph.add_edge("supervisor", "coder")
graph.add_edge("researcher", "supervisor")
graph.add_edge("coder", "supervisor")
