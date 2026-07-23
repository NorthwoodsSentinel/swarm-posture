from crewai import Agent, Task, Crew, Process

researcher = Agent(role="Senior Researcher", goal="find the facts", tools=[web_search, read_file], allow_delegation=False)
engineer   = Agent(role="Platform Engineer", goal="run the fix", tools=[shell_tool, sql_query], allow_delegation=True)

crew = Crew(agents=[researcher, engineer], tasks=[t1, t2], process=Process.hierarchical)
