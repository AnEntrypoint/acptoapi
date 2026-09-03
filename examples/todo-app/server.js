const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// In-memory todo store
let todos = [
  { id: 1, title: 'Sample todo', completed: false }
];
let nextId = 2;

// API endpoints
app.get('/api/todos', (req, res) => {
  res.json({ todos });
});

app.post('/api/todos', (req, res) => {
  const { title } = req.body;
  if (!title || typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }
  const todo = {
    id: nextId++,
    title: title.trim(),
    completed: false
  };
  todos.push(todo);
  res.status(201).json({ todo });
});

app.patch('/api/todos/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const todo = todos.find(t => t.id === id);
  if (!todo) return res.status(404).json({ error: 'todo not found' });

  if (req.body.title !== undefined) todo.title = req.body.title;
  if (req.body.completed !== undefined) todo.completed = req.body.completed;

  res.json({ todo });
});

app.delete('/api/todos/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const idx = todos.findIndex(t => t.id === id);
  if (idx < 0) return res.status(404).json({ error: 'todo not found' });

  const [removed] = todos.splice(idx, 1);
  res.json({ removed });
});

// HTML page
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Todo App</title>
      <style>
        body { font-family: sans-serif; max-width: 600px; margin: 50px auto; }
        #todos { list-style: none; padding: 0; }
        .todo-item { display: flex; align-items: center; padding: 10px; border-bottom: 1px solid #eee; }
        .todo-item input[type="checkbox"] { margin-right: 10px; }
        .todo-item.completed span { text-decoration: line-through; color: #999; }
        .todo-item button { margin-left: auto; background: red; color: white; border: none; padding: 5px 10px; cursor: pointer; }
        #input-section { margin-bottom: 20px; display: flex; gap: 10px; }
        input[type="text"] { flex: 1; padding: 8px; font-size: 14px; }
        button.add { background: green; color: white; border: none; padding: 8px 16px; cursor: pointer; }
      </style>
    </head>
    <body>
      <h1>Todo App</h1>
      <div id="input-section">
        <input type="text" id="title" placeholder="What needs to be done?" />
        <button class="add">Add</button>
      </div>
      <ul id="todos"></ul>
      <script>
        async function loadTodos() {
          const res = await fetch('/api/todos');
          const data = await res.json();
          const list = document.getElementById('todos');
          list.innerHTML = '';
          for (const todo of data.todos) {
            const li = document.createElement('li');
            li.className = 'todo-item' + (todo.completed ? ' completed' : '');
            li.innerHTML = \`
              <input type="checkbox" \${todo.completed ? 'checked' : ''} onchange="toggleTodo(\${todo.id})">
              <span>\${todo.title}</span>
              <button onclick="deleteTodo(\${todo.id})">Delete</button>
            \`;
            list.appendChild(li);
          }
        }

        async function addTodo() {
          const input = document.getElementById('title');
          if (!input.value.trim()) return;
          const res = await fetch('/api/todos', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: input.value })
          });
          input.value = '';
          loadTodos();
        }

        async function toggleTodo(id) {
          const res = await fetch(\`/api/todos/\${id}\`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ completed: true })
          });
          loadTodos();
        }

        async function deleteTodo(id) {
          const res = await fetch(\`/api/todos/\${id}\`, { method: 'DELETE' });
          loadTodos();
        }

        document.querySelector('.add').onclick = addTodo;
        document.getElementById('title').onkeypress = (e) => e.key === 'Enter' && addTodo();
        loadTodos();
      </script>
    </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(\`Todo app listening on http://localhost:\${PORT}\`);
});
